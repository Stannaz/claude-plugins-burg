/**
 * Voice transport for the discord MCP plugin.
 *
 * Phase 1: voice gateway connection, audio playback, edge-tts TTS.
 * No STT, no wake-word filter, no streaming chunker — those land in
 * later phases. See /root/burgplans/voice-fork-migration.md.
 *
 * Per-guild state:
 *   - VoiceConnection (one per guild — Discord's hard limit)
 *   - AudioPlayer
 *   - FIFO queue of items to play (file path | TTS text)
 *   - lockfile so a second plugin instance for the same guild bails
 *
 * The plugin is stdio-spawned by Claude Code, so all state here lives only
 * for the duration of this Claude Code session. Lockfiles get cleared in
 * shutdown(), and stale locks (PID gone) are reclaimed on the next join.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  EndBehaviorType,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice'
import type { Client, VoiceBasedChannel } from 'discord.js'
import { ChannelType } from 'discord.js'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import type { Readable } from 'stream'
import {
  STTSession,
  type TranscriptResult,
  deepgramKeyAvailable,
  budgetExceeded,
  deepgramUnavailable,
  setAvailabilityListener,
} from './stt'

const LOCK_DIR = '/root/burg/voice/locks'
const LOG_DIR = '/root/burg/voice/logs'
const LOG_FILE = `${LOG_DIR}/voice.log`
const TSV_HEADER = [
  'ts',
  'speaker_id',
  'speaker_name',
  'direction',
  'text',
  'deepgram_confidence',
  'deepgram_latency_ms',
  'gate_decision',
  'tts_first_audio_ms',
  'error',
].join('\t') + '\n'
const TTS_VOICE_DEFAULT = 'en-GB-RyanNeural'

type QueueItem =
  | { kind: 'file'; path: string }
  | { kind: 'tts'; text: string; voice: string }
  | { kind: 'stream'; stream: Readable; inputType: StreamType }

type GuildVoiceState = {
  guildId: string
  channelId: string
  connection: VoiceConnection
  player: AudioPlayer
  queue: QueueItem[]
  current: QueueItem | null
  /** Children we spawn (edge-tts, ffmpeg) so we can kill them on stop/leave. */
  childProcs: Set<ChildProcess>
  /** Active STT sessions keyed by userId — one per user currently speaking. */
  sttSessions: Map<string, STTSession>
  /** Recent bot utterances kept around for echo dedupe in server.ts.
   *  Pruned to a 5s window on every push. */
  recentUtterances: Array<{ text: string; ts: number }>
  /** Wall-clock ms until which we drop incoming PCM frames (echo guard).
   *  Set whenever the bot is mid-TTS or just finished one. */
  pcmMutedUntil: number
  /** Whether the player is currently rendering a TTS chunk. */
  ttsActive: boolean
  /** True once a budget_exceeded inbound was emitted today, so we don't
   *  spam the main session with repeats. */
  budgetEventSent: boolean
}

const states = new Map<string, GuildVoiceState>()

/** Cap on simultaneous open Deepgram ws across all guilds.
 *  Bumped 6→12 (2026-05-28): in a busy 5-6 person voice channel all 6 slots
 *  filled with crosstalk and a direct "burg" address lost the race and got
 *  dropped. 12 streams is still cheap (~$0.0043/min each) and well within the
 *  Deepgram key's concurrency limit; cap still guards pathological cases. */
const MAX_CONCURRENT_STT = 12

export type TTSFailure = { guildId: string; channelId: string; reason: string; text: string }

export type VoiceCallbacks = {
  /** Called when an edge-tts invocation fails. Plugin surfaces this as a one-shot
   * <voice tts_failed=true ...> inbound event so the main session knows the
   * spoken reply didn't go out. */
  onTTSFailure?: (failure: TTSFailure) => void
  /** Called once per finalised transcript from Deepgram. server.ts forwards
   *  every transcript as an inbound <voice> event (echo-guarded). */
  onTranscript?: (r: TranscriptResult) => void
  /** Called when a deepgram session errors out (auth, network, etc). */
  onSTTError?: (info: { guildId: string; channelId: string; userId: string; reason: string }) => void
  /** Called once-per-day-per-guild when the budget cap stops new sessions. */
  onBudgetExceeded?: (info: { guildId: string; channelId: string }) => void
  /** Repeated Deepgram failures tripped the breaker; STT is silently off. */
  onDeepgramUnavailable?: (info: { reason: string }) => void
  /** Health check succeeded; STT is back. */
  onDeepgramRecovered?: () => void
}

let callbacks: VoiceCallbacks = {}

export function setVoiceCallbacks(cb: VoiceCallbacks): void {
  callbacks = cb
  // Plumb stt.ts availability transitions out through the same callback bag.
  setAvailabilityListener({
    onUnavailable: reason => callbacks.onDeepgramUnavailable?.({ reason }),
    onRecovered: () => callbacks.onDeepgramRecovered?.(),
  })
}

function logVoice(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

export type GateDecision =
  | 'forwarded'
  | 'skipped_cooldown'
  | 'skipped_echo_match'
  | 'skipped_budget'
  | 'played_file'
  | 'tts_failed'

export type UtteranceLogRow = {
  speakerId: string
  speakerName: string
  direction: 'in' | 'out'
  text: string
  confidence?: number
  latencyMs?: number
  gateDecision: GateDecision
  ttsFirstAudioMs?: number
  error?: string
}

function tsvEscape(v: unknown): string {
  if (v == null) return ''
  return String(v).replace(/[\t\r\n]/g, ' ')
}

/** Append one row to /root/burg/voice/logs/voice-YYYY-MM-DD.tsv (auto-rotates
 *  daily by date in the filename — no external logrotate needed). */
export function logUtterance(row: UtteranceLogRow): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const path = `${LOG_DIR}/voice-${day}.tsv`
    if (!existsSync(path)) writeFileSync(path, TSV_HEADER)
    const line = [
      new Date().toISOString(),
      row.speakerId,
      row.speakerName,
      row.direction,
      row.text,
      row.confidence != null ? row.confidence.toFixed(3) : '',
      row.latencyMs != null ? String(row.latencyMs) : '',
      row.gateDecision,
      row.ttsFirstAudioMs != null ? String(row.ttsFirstAudioMs) : '',
      row.error ?? '',
    ].map(tsvEscape).join('\t') + '\n'
    appendFileSync(path, line)
  } catch (err) {
    logVoice(`tsv log failed: ${err instanceof Error ? err.message : err}`)
  }
}

function lockPath(guildId: string): string {
  return join(LOCK_DIR, `${guildId}.lock`)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tryAcquireLock(guildId: string): { ok: true } | { ok: false; holder: number } {
  mkdirSync(LOCK_DIR, { recursive: true })
  const path = lockPath(guildId)
  if (existsSync(path)) {
    let holder = 0
    try {
      holder = parseInt(readFileSync(path, 'utf8').trim(), 10)
    } catch {}
    if (holder && holder !== process.pid && isPidAlive(holder)) {
      return { ok: false, holder }
    }
  }
  writeFileSync(path, String(process.pid))
  return { ok: true }
}

function releaseLock(guildId: string): void {
  const path = lockPath(guildId)
  try {
    if (!existsSync(path)) return
    const holder = parseInt(readFileSync(path, 'utf8').trim(), 10)
    if (holder === process.pid) rmSync(path, { force: true })
  } catch {}
}

/**
 * Join a voice channel by id. Returns the resolved guild id on success.
 * Throws on permission/connection failures with a human-readable string.
 */
export async function joinVoice(client: Client, channelId: string): Promise<string> {
  const ch = await client.channels.fetch(channelId)
  if (!ch || ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) {
    throw new Error(`channel ${channelId} is not a voice channel`)
  }
  const voiceCh = ch as VoiceBasedChannel
  const me = voiceCh.guild.members.me ?? (await voiceCh.guild.members.fetchMe())
  const perms = voiceCh.permissionsFor(me)
  if (!perms?.has('Connect') || !perms?.has('Speak')) {
    throw new Error(`missing voice perms in #${voiceCh.name} (need Connect + Speak)`)
  }

  const guildId = voiceCh.guild.id
  const lock = tryAcquireLock(guildId)
  if (!lock.ok) {
    throw new Error(`another plugin instance (pid ${lock.holder}) holds the voice lock for guild ${guildId}`)
  }

  // If we're already in a channel for this guild, just move.
  const existing = states.get(guildId)
  if (existing && existing.channelId === channelId) {
    return guildId
  }
  if (existing) {
    // Switching channels within the guild: tear the old state down completely
    // (timer + STT + children) before replacing it. We hold the lock across
    // this, so don't release it here.
    teardownState(existing)
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: voiceCh.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  })

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
  } catch (err) {
    connection.destroy()
    releaseLock(guildId)
    throw new Error(`voice connection never became ready: ${err instanceof Error ? err.message : err}`)
  }

  const player = createAudioPlayer()
  connection.subscribe(player)

  const state: GuildVoiceState = {
    guildId,
    channelId,
    connection,
    player,
    queue: [],
    current: null,
    childProcs: new Set(),
    sttSessions: new Map(),
    recentUtterances: [],
    pcmMutedUntil: 0,
    ttsActive: false,
    budgetEventSent: false,
  }
  states.set(guildId, state)
  wireSTT(client, state)

  /** PCM-mute window after each TTS chunk to suppress immediate echo back
   *  through Deepgram. Belt-and-braces alongside the text-level dedupe in
   *  server.ts. */
  const ECHO_MUTE_TAIL_MS = 300

  player.on(AudioPlayerStatus.Playing, () => {
    if (state.current?.kind === 'tts') {
      state.ttsActive = true
      // While TTS is playing, push the muted-until forward so PCM stays
      // suppressed; we drop it back to now+ECHO_MUTE_TAIL_MS once it ends.
      state.pcmMutedUntil = Date.now() + 60_000
    }
  })
  player.on(AudioPlayerStatus.Idle, () => {
    if (state.ttsActive) {
      state.ttsActive = false
      state.pcmMutedUntil = Date.now() + ECHO_MUTE_TAIL_MS
    }
    state.current = null
    void runQueue(state)
  })
  player.on('error', err => {
    logVoice(`player error in guild ${guildId}: ${err.message}`)
    if (state.ttsActive) {
      state.ttsActive = false
      state.pcmMutedUntil = Date.now() + ECHO_MUTE_TAIL_MS
    }
    state.current = null
    void runQueue(state)
  })
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ])
      // The connection is re-establishing itself (e.g. a voice region change) —
      // let it recover on its own.
    } catch {
      // A real drop (gateway close / timeout). Tear the dead state down and try
      // to rejoin the same channel once, so a transient disconnect doesn't leave
      // the bot silently out of voice until someone notices. joinVoice
      // re-acquires the lock and rebuilds the player/STT/presence wiring; if it
      // throws (channel gone, perms revoked, persistent network failure) we stay
      // out rather than hot-looping — the 15s ready-timeout paces any retry.
      logVoice(`voice disconnected in guild ${guildId}; attempting rejoin to ${channelId}`)
      teardownState(state)
      releaseLock(guildId)
      try {
        await joinVoice(client, channelId)
        logVoice(`voice auto-rejoin to ${channelId} succeeded`)
      } catch (err) {
        logVoice(`voice auto-rejoin to ${channelId} failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  })

  logVoice(`joined voice channel ${channelId} in guild ${guildId}`)
  return guildId
}

export function leaveVoice(guildId?: string): string {
  const target = guildId ?? (states.size === 1 ? [...states.keys()][0] : undefined)
  if (!target) {
    if (states.size === 0) return 'not connected to any voice channel'
    throw new Error(`multiple guilds connected, specify guild_id`)
  }
  const s = states.get(target)
  if (!s) return `not connected in guild ${target}`
  teardownState(s)
  releaseLock(target)
  logVoice(`left voice in guild ${target}`)
  return `left voice in guild ${target}`
}

export function leaveAll(): void {
  for (const guildId of [...states.keys()]) {
    try { leaveVoice(guildId) } catch {}
  }
}

function killChildren(s: GuildVoiceState): void {
  for (const child of s.childProcs) {
    try { child.kill('SIGKILL') } catch {}
  }
  s.childProcs.clear()
}

function killSTTSessions(s: GuildVoiceState): void {
  for (const session of s.sttSessions.values()) {
    try { session.destroy() } catch {}
  }
  s.sttSessions.clear()
}

/**
 * Fully tear a guild's voice state down: stop STT sessions, spawned children and
 * audio, destroy the connection, and drop it from the registry. Does NOT release
 * the lockfile — callers that relinquish the guild (leaveVoice, the disconnect
 * handler) release it explicitly, while a channel-switch keeps the lock and
 * re-uses it for the new connection.
 */
function teardownState(s: GuildVoiceState): void {
  killSTTSessions(s)
  killChildren(s)
  try { s.player.stop(true) } catch {}
  try { s.connection.destroy() } catch {}
  states.delete(s.guildId)
}

/** Sum of active STT sessions across every guild — for the global concurrency cap. */
function totalActiveSTTSessions(): number {
  let n = 0
  for (const s of states.values()) n += s.sttSessions.size
  return n
}

/**
 * Wire @discordjs/voice receiver → Deepgram STT.
 *
 * Subscribes per-user opus streams when a user starts speaking. The receiver
 * stream ends naturally after 2s of silence (EndBehaviorType.AfterSilence),
 * which closes the Deepgram ws. Re-subscribing happens on the next
 * speaking.start.
 *
 * Known limitation (acceptable for v1, noted in plan): subscribing on the
 * gateway's `speaking.start` event lags raw RTP packet arrival by up to
 * ~100ms, so the very first ~100ms of the first utterance may be clipped.
 */
function wireSTT(client: Client, state: GuildVoiceState): void {
  if (!deepgramKeyAvailable()) {
    logVoice(`stt: deepgram key unavailable; staying deaf in guild ${state.guildId}`)
    return
  }
  const botUserId = client.user?.id
  const receiver = state.connection.receiver

  logVoice(`stt: wireSTT attached, listenerCount=${receiver.speaking.listenerCount('start')}`)
  receiver.speaking.on('start', userId => {
    if (userId === botUserId) return
    if (state.sttSessions.has(userId)) return
    logVoice(`stt: NEW speaking.start userId=${userId} listeners=${receiver.speaking.listenerCount('start')}`)
    if (totalActiveSTTSessions() >= MAX_CONCURRENT_STT) {
      logVoice(`stt: concurrency cap (${MAX_CONCURRENT_STT}) hit, skipping userId=${userId}`)
      return
    }
    if (budgetExceeded()) {
      // First trip of the day → emit a one-shot inbound so the model knows
      // STT is silently off. After that, just log.
      if (!state.budgetEventSent) {
        state.budgetEventSent = true
        callbacks.onBudgetExceeded?.({
          guildId: state.guildId,
          channelId: state.channelId,
        })
      }
      logVoice(`stt: budget exceeded, refusing new session for userId=${userId}`)
      return
    }
    if (deepgramUnavailable()) {
      // Health check is running on its own timer; just refuse new sessions
      // until it flips back. The inbound event was already emitted by the
      // availability listener.
      return
    }

    let opusStream
    try {
      opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 2000 },
      })
    } catch (err) {
      logVoice(`stt: receiver.subscribe failed for ${userId}: ${err instanceof Error ? err.message : err}`)
      return
    }
    logVoice(`stt: subscribed userId=${userId}`)

    let session: STTSession
    try {
      session = new STTSession({
        userId,
        guildId: state.guildId,
        channelId: state.channelId,
        opusStream,
        shouldDropPCM: () => Date.now() < state.pcmMutedUntil,
        onTranscript: r => {
          logVoice(`stt: transcript userId=${userId} text=${JSON.stringify(r.text)} latency=${r.latencyMs}ms`)
          callbacks.onTranscript?.(r)
        },
        onOpen: () => logVoice(`stt: ws open userId=${userId}`),
        onFirstFrame: () => logVoice(`stt: first PCM frame sent userId=${userId}`),
        onError: err => {
          callbacks.onSTTError?.({
            guildId: state.guildId,
            channelId: state.channelId,
            userId,
            reason: err.message,
          })
          logVoice(`stt error guild=${state.guildId} user=${userId}: ${err.message}`)
        },
        onClose: info => {
          const codeStr = info?.code !== undefined ? `code=${info.code}` : 'code=?'
          const reasonStr = info?.reason ? ` reason=${JSON.stringify(info.reason)}` : ''
          const preOpenStr = info?.preOpen ? ' preOpen=true' : ''
          logVoice(`stt: session closed userId=${userId} ${codeStr}${reasonStr}${preOpenStr}`)
          state.sttSessions.delete(userId)
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
      logVoice(`stt: STTSession ctor threw for ${userId}: ${msg}`)
      try { opusStream.destroy() } catch {}
      return
    }
    state.sttSessions.set(userId, session)
    try {
      session.start()
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
      logVoice(`stt: session.start() threw for ${userId}: ${msg}`)
      state.sttSessions.delete(userId)
      try { session.destroy() } catch {}
      return
    }

    // Defensive: if the opus stream ends (silence, user leaves), tell the
    // session to flush — the ws close handler will then drop it from the map.
    opusStream.on('end', () => {
      try { session.finish() } catch {}
    })
  })
}

function pickGuild(guildId?: string): GuildVoiceState {
  if (guildId) {
    const s = states.get(guildId)
    if (!s) throw new Error(`not connected in guild ${guildId} — call voice_join first`)
    return s
  }
  if (states.size === 0) throw new Error('not connected to any voice channel — call voice_join first')
  if (states.size === 1) return [...states.values()][0]
  throw new Error('multiple guilds connected, specify guild_id')
}

export function enqueueFile(path: string, guildId?: string): void {
  const s = pickGuild(guildId)
  s.queue.push({ kind: 'file', path })
  void runQueue(s)
}

export function enqueueTTS(text: string, voice = TTS_VOICE_DEFAULT, guildId?: string): void {
  const s = pickGuild(guildId)
  // voice_say always wins — clear queue + stop current. Per the plan, music
  // playback is text-side only and never auto-resumes.
  s.queue = s.queue.filter(item => item.kind === 'tts')
  if (s.current && s.current.kind !== 'tts') {
    killChildren(s)
    try { s.player.stop(true) } catch {}
  }
  s.queue.push({ kind: 'tts', text, voice })
  recordBotUtterance(s, text)
  logUtterance({
    speakerId: 'BOT', speakerName: 'BOT', direction: 'out',
    text, gateDecision: 'forwarded',
  })
  void runQueue(s)
}

/** Echo-dedupe ring buffer: 5 second window of recent bot utterances. */
const ECHO_WINDOW_MS = 5000
const ECHO_MIN_SIMILARITY = 0.7

function recordBotUtterance(s: GuildVoiceState, text: string): void {
  const now = Date.now()
  s.recentUtterances.push({ text, ts: now })
  s.recentUtterances = s.recentUtterances.filter(u => now - u.ts <= ECHO_WINDOW_MS)
}

function normaliseForEcho(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Jaccard similarity over normalised token sets. Cheap and deterministic;
 *  good enough for "did the bot just say this?" given how short utterances are. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * Returns true if `transcript` looks like an echo of something the bot said in
 * the last 5 seconds. Used by server.ts to drop self-heard transcripts so the
 * bot doesn't loop on its own TTS.
 */
export function isLikelyBotEcho(transcript: string, guildId: string): boolean {
  const s = states.get(guildId)
  if (!s || s.recentUtterances.length === 0) return false
  const now = Date.now()
  const heard = normaliseForEcho(transcript)
  if (heard.length === 0) return false
  for (const u of s.recentUtterances) {
    if (now - u.ts > ECHO_WINDOW_MS) continue
    const said = normaliseForEcho(u.text)
    if (jaccard(heard, said) >= ECHO_MIN_SIMILARITY) return true
  }
  return false
}

export function stopPlayback(guildId?: string): void {
  const s = pickGuild(guildId)
  s.queue = []
  killChildren(s)
  try { s.player.stop(true) } catch {}
}

export function status(): string {
  if (states.size === 0) return 'not connected'
  const lines: string[] = []
  for (const s of states.values()) {
    const cur = s.current ? describeItem(s.current) : 'idle'
    lines.push(`guild ${s.guildId} channel ${s.channelId}: ${cur} (queued: ${s.queue.length})`)
  }
  return lines.join('\n')
}

function describeItem(item: QueueItem): string {
  if (item.kind === 'file') return `file ${item.path}`
  if (item.kind === 'tts') return `tts "${item.text.slice(0, 40)}${item.text.length > 40 ? '…' : ''}"`
  return 'stream'
}

async function runQueue(s: GuildVoiceState): Promise<void> {
  if (s.current) return
  const next = s.queue.shift()
  if (!next) return
  s.current = next
  try {
    if (next.kind === 'file') {
      await playFileNow(s, next.path)
    } else if (next.kind === 'tts') {
      await playTTSNow(s, next.text, next.voice)
    } else {
      await playStreamNow(s, next.stream, next.inputType)
    }
  } catch (err) {
    logVoice(`queue item failed: ${err instanceof Error ? err.message : err}`)
    s.current = null
    void runQueue(s)
  }
}

async function playFileNow(s: GuildVoiceState, path: string): Promise<void> {
  const resource = createAudioResource(path, { inputType: StreamType.Arbitrary })
  s.player.play(resource)
}

async function playStreamNow(s: GuildVoiceState, stream: Readable, inputType: StreamType): Promise<void> {
  const resource = createAudioResource(stream, { inputType })
  s.player.play(resource)
}

/**
 * TTS via edge-tts CLI → MP3 stdout → ffmpeg → @discordjs/voice transcoder
 * (StreamType.Arbitrary makes prism-media's FFmpeg handle the rest).
 *
 * On edge-tts spawn or non-zero exit, surface a tts_failed callback so the
 * main session knows the spoken reply didn't go out.
 */
async function playTTSNow(s: GuildVoiceState, text: string, voice: string): Promise<void> {
  const proc = spawn('edge-tts', ['--voice', voice, '--text', text], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!proc.stdout || !proc.stderr) {
    throw new Error('edge-tts: stdio pipes did not initialise')
  }
  s.childProcs.add(proc)
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

  const failureFired = { v: false }
  const fail = (reason: string) => {
    if (failureFired.v) return
    failureFired.v = true
    logVoice(`edge-tts failed in guild ${s.guildId}: ${reason}`)
    callbacks.onTTSFailure?.({ guildId: s.guildId, channelId: s.channelId, reason, text })
  }

  proc.on('error', err => {
    fail(`spawn error: ${err.message}`)
    s.childProcs.delete(proc)
  })
  proc.on('exit', (code, signal) => {
    s.childProcs.delete(proc)
    if (signal === 'SIGKILL') return // we killed it ourselves (stop/leave)
    if (code !== 0) {
      const tail = stderr.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 240)
      fail(`exit ${code}${tail ? `: ${tail}` : ''}`)
    }
  })

  const resource = createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary })
  s.player.play(resource)
}

// Voice connections must be torn down on plugin shutdown — leaving them open
// holds Discord-side voice state and prevents reconnection until timeout.
export function shutdownVoice(): void {
  leaveAll()
}
