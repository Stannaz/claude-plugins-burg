/**
 * Presence tracking — burg fork addition.
 *
 * Listens for PRESENCE_UPDATE gateway events and persists status transitions
 * (online/idle/dnd/offline) per user to a sqlite DB. Used by the weekly
 * activity gantt report.
 *
 * Requires the privileged GuildPresences intent (toggled in the Discord dev
 * portal AND requested in server.ts's intents list). Caller should gate on
 * ENABLE_PRESENCE_TRACKING=1 to keep the intent optional.
 */

import { Database } from 'bun:sqlite'
import type { Client, Presence } from 'discord.js'
import { ActivityType } from 'discord.js'

const DB_PATH = process.env.PRESENCE_DB_PATH ?? '/root/burg/presence.db'

let db: Database | null = null
const lastStatus = new Map<string, string>()

function openDb(): Database {
  const d = new Database(DB_PATH)
  d.exec(`
    CREATE TABLE IF NOT EXISTS presence_events (
      user_id  TEXT    NOT NULL,
      guild_id TEXT    NOT NULL,
      status   TEXT    NOT NULL,
      ts       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_presence_ts ON presence_events(ts);
    CREATE INDEX IF NOT EXISTS idx_presence_user_ts ON presence_events(user_id, ts);
    CREATE TABLE IF NOT EXISTS presence_users (
      user_id      TEXT PRIMARY KEY,
      username     TEXT,
      display_name TEXT,
      last_seen    INTEGER
    );
    CREATE TABLE IF NOT EXISTS presence_nicks (
      guild_id  TEXT    NOT NULL,
      user_id   TEXT    NOT NULL,
      nick      TEXT,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `)
  // Add activity col idempotently for existing DBs.
  const cols = d.query("PRAGMA table_info(presence_events)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'activity')) {
    d.exec('ALTER TABLE presence_events ADD COLUMN activity TEXT')
  }
  return d
}

function pickActivity(p: Presence): string | null {
  // First non-custom-status activity wins. Type 4 (Custom) is the user's
  // freeform status text/emoji, not a game/app. Types 0/1/2/3/5 are
  // Playing/Streaming/Listening/Watching/Competing — all useful signal.
  for (const act of p.activities ?? []) {
    if (act.type === ActivityType.Custom) continue
    if (act.name) return act.name
  }
  return null
}

function record(p: Presence): void {
  if (!db || !p.userId || !p.guild) return
  const status = p.status ?? 'offline'
  const activity = pickActivity(p)
  const key = `${p.guild.id}:${p.userId}`
  const sig = `${status}|${activity ?? ''}`
  if (lastStatus.get(key) === sig) return
  lastStatus.set(key, sig)

  const ts = Math.floor(Date.now() / 1000)
  db.run(
    'INSERT INTO presence_events (user_id, guild_id, status, ts, activity) VALUES (?, ?, ?, ?, ?)',
    [p.userId, p.guild.id, status, ts, activity],
  )

  const user = p.user ?? p.member?.user
  const member = p.member
  db.run(
    `INSERT INTO presence_users (user_id, username, display_name, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = COALESCE(excluded.username, presence_users.username),
       display_name = COALESCE(excluded.display_name, presence_users.display_name),
       last_seen = excluded.last_seen`,
    [p.userId, user?.username ?? null, member?.displayName ?? user?.globalName ?? null, ts],
  )

  // Per-guild server nickname. member.nickname is the literal server nick or
  // null if the user hasn't set one — we store the null so queries can fall
  // back to display_name/username via COALESCE.
  const nick = member?.nickname ?? null
  db.run(
    `INSERT INTO presence_nicks (guild_id, user_id, nick, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       nick = excluded.nick,
       last_seen = excluded.last_seen`,
    [p.guild.id, p.userId, nick, ts],
  )
}

export function setupPresenceTracking(client: Client): void {
  db = openDb()
  process.stderr.write(`discord channel: presence tracking enabled → ${DB_PATH}\n`)

  // Seed current presence on ready (members already online when we connect).
  client.once('ready', () => {
    let seeded = 0
    for (const guild of client.guilds.cache.values()) {
      for (const presence of guild.presences.cache.values()) {
        record(presence)
        seeded++
      }
    }
    process.stderr.write(`discord channel: seeded ${seeded} presences\n`)
  })

  client.on('presenceUpdate', (_old, next) => {
    if (next) record(next)
  })
}
