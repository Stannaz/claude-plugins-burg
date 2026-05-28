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
  `)
  return d
}

function record(p: Presence): void {
  if (!db || !p.userId || !p.guild) return
  const status = p.status ?? 'offline'
  const key = `${p.guild.id}:${p.userId}`
  if (lastStatus.get(key) === status) return
  lastStatus.set(key, status)

  const ts = Math.floor(Date.now() / 1000)
  db.run(
    'INSERT INTO presence_events (user_id, guild_id, status, ts) VALUES (?, ?, ?, ?)',
    [p.userId, p.guild.id, status, ts],
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
