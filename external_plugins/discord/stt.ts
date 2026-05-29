/**
 * Deepgram live STT for the discord MCP plugin.
 *
 * Phase 2 of the voice fork — see /root/burgplans/voice-fork-migration.md.
 *
 * One STTSession per (guild, user) actively speaking. Lifecycle:
 *   constructor → start()
 *     → opens deepgram ws (model nova-3, linear16 48k stereo, mip_opt_out=true)
 *     → pipes the user's @discordjs/voice opus stream through prism-media's
 *       opus decoder, then sends each PCM chunk as a binary ws frame
 *   on Results event with is_final=true && speech_final=true
 *     → onTranscript callback fires once per finalised utterance
 *   end of opus stream OR finish() OR ws close
 *     → session torn down; caller must spin up a new one for the next
 *       speaking burst
 *
 * Idle channel = no STTSessions = $0. Voice receiver subscriptions in voice.ts
 * spin sessions up lazily on first audio packet and tear them down ~2s after
 * speaking stops, keeping the bill aligned with active talk time.
 */

import WebSocket from 'ws'
import prism from 'prism-media'
import { readFileSync, existsSync } from 'fs'
import type { AudioReceiveStream } from '@discordjs/voice'

const DEEPGRAM_KEY_PATH = '/root/.deepgram_key'
const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'

/** Deepgram Nova-3 streaming pricing (2026-05-10): $0.0043 per minute. */
const DEEPGRAM_USD_PER_MIN = 0.0043

/** Daily soft cap on Deepgram spend, in USD. Override via env DEEPGRAM_DAILY_CAP_USD. */
const DAILY_CAP_USD = Number.isFinite(Number(process.env.DEEPGRAM_DAILY_CAP_USD))
  ? Number(process.env.DEEPGRAM_DAILY_CAP_USD)
  : 5.0

type DailySpend = { utcDay: string; spendUsd: number }
let dailySpend: DailySpend = { utcDay: utcDayKey(), spendUsd: 0 }

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

function rolloverIfNewDay(): void {
  const today = utcDayKey()
  if (dailySpend.utcDay !== today) {
    dailySpend = { utcDay: today, spendUsd: 0 }
  }
}

/** Account for a closed session's wall-clock duration (approximation of audio sent). */
function recordSessionDuration(seconds: number): void {
  rolloverIfNewDay()
  dailySpend.spendUsd += (seconds / 60) * DEEPGRAM_USD_PER_MIN
}

function dailySpendUsd(): number {
  rolloverIfNewDay()
  return dailySpend.spendUsd
}

export function dailyCapUsd(): number {
  return DAILY_CAP_USD
}

/** True when today's projected spend has already met or exceeded the daily cap.
 *  Caller must check this BEFORE opening a new STTSession. */
export function budgetExceeded(): boolean {
  return dailySpendUsd() >= DAILY_CAP_USD
}

/* ── Deepgram availability tracker ──────────────────────────────────────────
 * 3 connection failures in a 60s sliding window flips the plugin "deaf":
 * future STT sessions are refused, a one-shot inbound event surfaces, and a
 * 60s health-check ping waits for recovery before we resume. TTS / playback
 * are unaffected.
 */

const FAILURE_WINDOW_MS = 60_000
const FAILURE_THRESHOLD = 3
const HEALTH_CHECK_INTERVAL_MS = 60_000
let recentFailures: number[] = []
let _unavailable = false
let _lastUnavailableReason = ''
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

export type AvailabilityListener = {
  onUnavailable: (reason: string) => void
  onRecovered: () => void
}
let availabilityListener: AvailabilityListener | null = null

export function setAvailabilityListener(l: AvailabilityListener): void {
  availabilityListener = l
}

export function deepgramUnavailable(): boolean {
  return _unavailable
}

function recordFailure(reason: string): void {
  const now = Date.now()
  recentFailures = recentFailures.filter(t => now - t < FAILURE_WINDOW_MS)
  recentFailures.push(now)
  if (!_unavailable && recentFailures.length >= FAILURE_THRESHOLD) {
    _unavailable = true
    _lastUnavailableReason = reason
    availabilityListener?.onUnavailable(reason)
    startHealthCheck()
  }
}

function startHealthCheck(): void {
  if (healthCheckTimer) return
  healthCheckTimer = setInterval(() => {
    runHealthCheck().catch(() => {})
  }, HEALTH_CHECK_INTERVAL_MS)
}

async function runHealthCheck(): Promise<void> {
  let token: string
  try { token = getDeepgramKey() } catch { return }
  const probeUrl = buildDeepgramUrl()
  await new Promise<void>(resolve => {
    const ws = new WebSocket(probeUrl, { headers: { Authorization: `Token ${token}` } })
    const done = (ok: boolean) => {
      try { ws.terminate() } catch {}
      if (ok) markRecovered()
      resolve()
    }
    const timer = setTimeout(() => done(false), 5_000)
    ws.on('open', () => { clearTimeout(timer); done(true) })
    ws.on('error', () => { clearTimeout(timer); done(false) })
  })
}

function markRecovered(): void {
  if (!_unavailable) return
  _unavailable = false
  recentFailures = []
  _lastUnavailableReason = ''
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
  availabilityListener?.onRecovered()
}

let cachedKey: string | null = null
function getDeepgramKey(): string {
  if (cachedKey !== null) return cachedKey
  if (!existsSync(DEEPGRAM_KEY_PATH)) {
    throw new Error(`deepgram key not found at ${DEEPGRAM_KEY_PATH}`)
  }
  const k = readFileSync(DEEPGRAM_KEY_PATH, 'utf8').trim()
  if (!k) throw new Error(`deepgram key file ${DEEPGRAM_KEY_PATH} is empty`)
  cachedKey = k
  return k
}

export type TranscriptResult = {
  userId: string
  guildId: string
  channelId: string
  /** The finalised utterance text. */
  text: string
  confidence: number
  /** ms from session start (i.e. first audio frame) to when deepgram returned the final. */
  latencyMs: number
}

export type STTSessionOpts = {
  userId: string
  guildId: string
  channelId: string
  /** Per-user opus packet stream from @discordjs/voice receiver.subscribe(...). */
  opusStream: AudioReceiveStream
  onTranscript: (r: TranscriptResult) => void
  /** Fired on ws errors (network, auth, deepgram-side). */
  onError?: (err: Error) => void
  /** Fired once when the session has fully torn down. Includes the ws close
   *  code/reason if known (otherwise undefined — e.g. local destroy). */
  onClose?: (info?: { code?: number; reason?: string; preOpen?: boolean }) => void
  /** Fired once when the deepgram websocket has opened. */
  onOpen?: () => void
  /** Fired once when the first PCM frame is sent to deepgram. */
  onFirstFrame?: () => void
  /** Optional per-frame PCM gate. When this returns true, the frame is
   *  dropped instead of sent to Deepgram — used to suppress echo while the
   *  bot itself is speaking. */
  shouldDropPCM?: () => boolean
}

/**
 * Connection params for deepgram live. Keep in sync with the plan's hard
 * requirements (mip_opt_out=true is non-negotiable — opts out of model
 * improvement program).
 */
function buildDeepgramUrl(): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    encoding: 'linear16',
    sample_rate: '48000',
    channels: '2',
    mip_opt_out: 'true',
  })
  // Keyterm prompting (nova-3): boost the bot's own wake words so they're reliably
  // transcribed and the `\bburg\b` wake gate actually fires. Repeatable param.
  for (const term of ['burg', 'burger', 'bot']) params.append('keyterm', term)
  return `${DEEPGRAM_LIVE_URL}?${params.toString()}`
}

export class STTSession {
  private ws: WebSocket | null = null
  private decoder: prism.opus.Decoder
  private closed = false
  private finalised = false
  /** ms timestamp of first PCM frame sent to deepgram; used for latency reporting. */
  private firstFrameAtMs: number | null = null
  /** Have we seen the ws 'open' event? Used to classify failures (pre-open
   *  closures count toward the unavailability tracker; post-open ones
   *  usually mean the user just stopped speaking). */
  private wsOpened = false
  /** Close info captured from ws 'close' event so cleanup can hand it to
   *  the onClose callback for logging. */
  private closeInfo: { code?: number; reason?: string; preOpen?: boolean } | undefined
  private opts: STTSessionOpts

  constructor(opts: STTSessionOpts) {
    this.opts = opts
    // Discord voice is opus 48k stereo, 20ms frames (960 samples per channel).
    this.decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
  }

  start(): void {
    let url: string
    let token: string
    try {
      url = buildDeepgramUrl()
      token = getDeepgramKey()
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
      this.cleanup()
      return
    }

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${token}` },
    })

    this.ws.on('open', () => {
      this.wsOpened = true
      this.opts.onOpen?.()
      if (this.closed) {
        try { this.ws?.close() } catch {}
        return
      }
      // Pipe opus frames → PCM → ws. Decoder is a Transform so we read
      // 'data' events and forward as binary. Backpressure is fine: deepgram
      // accepts faster than discord produces.
      this.opts.opusStream.pipe(this.decoder)
      this.decoder.on('data', (pcm: Buffer) => {
        if (this.closed) return
        if (this.opts.shouldDropPCM?.()) return
        if (!this.firstFrameAtMs) {
          this.firstFrameAtMs = Date.now()
          this.opts.onFirstFrame?.()
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          try { this.ws.send(pcm) } catch (err) {
            this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
          }
        }
      })
      this.decoder.on('end', () => this.finish())
      this.decoder.on('error', err => {
        this.opts.onError?.(err)
        this.finish()
      })
      this.opts.opusStream.on('end', () => this.finish())
      this.opts.opusStream.on('error', err => {
        this.opts.onError?.(err)
        this.finish()
      })
    })

    this.ws.on('message', (data: WebSocket.RawData) => {
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      this.handleDeepgramMessage(msg)
    })

    this.ws.on('error', err => {
      // Errors before 'open' = connection failure (DNS/auth/network).
      // After 'open' = mid-stream blip; don't penalise availability.
      if (!this.wsOpened) recordFailure(`ws error: ${err.message}`)
      this.opts.onError?.(err)
    })

    this.ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf?.toString() || ''
      this.closeInfo = { code, reason, preOpen: !this.wsOpened }
      // Codes 1000/1006 are normal close / abnormal-but-non-deepgram-fault.
      // Pre-open closes always count; post-open closes only if the server
      // sent a non-1000 code (e.g. 4xxx auth/billing).
      if (!this.wsOpened || (code !== 1000 && code !== 1006)) {
        recordFailure(`ws close pre-open=${!this.wsOpened}: ${reason || `code ${code}`}`)
      }
      this.cleanup()
    })
  }

  private handleDeepgramMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as Record<string, unknown>
    if (m.type !== 'Results') return
    // Schema (relevant fields):
    //   { type: "Results", channel: { alternatives: [{ transcript, confidence }] },
    //     is_final: bool, speech_final: bool, ... }
    const channel = m.channel as { alternatives?: Array<{ transcript?: string; confidence?: number }> } | undefined
    const alt = channel?.alternatives?.[0]
    const text = alt?.transcript?.trim()
    if (!text) return
    const isFinal = m.is_final === true
    const speechFinal = m.speech_final === true
    if (!(isFinal && speechFinal)) return

    const finalisedAt = Date.now()
    this.opts.onTranscript({
      userId: this.opts.userId,
      guildId: this.opts.guildId,
      channelId: this.opts.channelId,
      text,
      confidence: typeof alt!.confidence === 'number' ? alt!.confidence : 0,
      latencyMs: this.firstFrameAtMs ? finalisedAt - this.firstFrameAtMs : 0,
    })
  }

  /**
   * Caller signals end-of-utterance: tell deepgram we're done so it flushes
   * any pending interim. The ws will close shortly after.
   */
  finish(): void {
    if (this.finalised) return
    this.finalised = true
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Deepgram protocol: a JSON CloseStream message asks the server to
        // flush + close gracefully. Falling back to ws.close() if write fails.
        this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        try { this.ws.close() } catch {}
      }
    } else {
      try { this.ws?.close() } catch {}
    }
  }

  private cleanup(): void {
    if (this.closed) return
    this.closed = true
    if (this.firstFrameAtMs) {
      const seconds = Math.max(0, (Date.now() - this.firstFrameAtMs) / 1000)
      recordSessionDuration(seconds)
    }
    try { this.opts.opusStream.unpipe(this.decoder) } catch {}
    try { this.decoder.destroy() } catch {}
    try { this.ws?.terminate() } catch {}
    this.ws = null
    this.opts.onClose?.(this.closeInfo)
  }

  /** Force-close immediately (e.g. plugin shutdown, leave voice). */
  destroy(): void {
    this.finalised = true
    this.cleanup()
  }
}

/**
 * Cheap pre-flight so the plugin can refuse to start phase-2 work if the key
 * is missing/empty. Safe to call repeatedly (cached after first read).
 */
export function deepgramKeyAvailable(): boolean {
  try {
    getDeepgramKey()
    return true
  } catch {
    return false
  }
}
