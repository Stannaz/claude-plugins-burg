# claude-plugins-burg — fork notes

Personal fork of [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official) for the burg deployment. The upstream `README.md` is left untouched on purpose; **everything fork-specific lives here.**

## Why this exists

Most of this marketplace is upstream-as-is. The fork is here so we can extend specific plugins (currently just `external_plugins/discord`) with features that aren't appropriate to upstream — features tightly coupled to how this particular Discord channel is used by the burg bot.

## Custom additions

Fork-only files in `external_plugins/discord`: `voice.ts`, `stt.ts`, `presence.ts`, `assets/`. Everything else there is an upstream file; in `server.ts` our additions sit in blocks between upstream code. `package.json` gains the voice/STT dependencies (`@discordjs/voice`, `@discordjs/opus` with `opusscript` as fallback, `libsodium-wrappers`, `prism-media`, `ws`) and the typecheck devDependencies. `.claude-plugin/marketplace.json` renames the marketplace to `burg-plugins`.

### `external_plugins/discord` — voice transport and tools

`voice.ts` owns the voice connection, one per guild: a player, a FIFO queue of files and TTS, a per-guild pid lockfile under `/root/burg/voice/locks`, auto-rejoin and leave-when-alone (both below). `server.ts` exposes it as seven tools: `voice_join`, `voice_leave`, `voice_play`, `voice_say`, `voice_stop`, `voice_status`, `voice_who`. `voice_say` (edge-tts, default voice `TTS_VOICE_DEFAULT`) preempts file playback with no auto-resume. The client requests the `GuildVoiceStates` and `GuildMembers` intents for this. `shutdownVoice()` is called from the upstream `shutdown()`.

### `external_plugins/discord` — voice STT and wake word

`stt.ts` runs one Deepgram live session (`nova-3`, `mip_opt_out=true`) per user while they are speaking; `wireSTT` in `voice.ts` opens them on `speaking.start` and they close after 2s of silence, so an idle channel costs nothing. Limits: `MAX_CONCURRENT_STT` (12) sessions, a daily spend cap (`DEEPGRAM_DAILY_CAP_USD`, default $5, resets 00:00 UTC), and an availability breaker (3 connection failures in 60s pauses STT until a 60s health check succeeds). The key is read from `/root/.deepgram_key`; without it the bot joins deaf.

`server.ts` wires the results through `setVoiceCallbacks`. A finalised transcript is dropped if it echoes the bot's own recent TTS (`isLikelyBotEcho`), dropped if it lacks the wake word (`VOICE_WAKE_RE`: "burg", "burger", "burgers"), and otherwise forwarded as a `<voice>` inbound. TTS failures, the budget cap, and Deepgram going down or recovering each arrive as a one-shot `<voice>` inbound too. All five go through `notifyVoice`.

### `external_plugins/discord` — join stings

On a human entering a voice channel in the one guild `JOIN_STING_GUILD_ID`, a `voiceStateUpdate` handler in `server.ts` joins that channel and plays one clip picked from the weighted `JOIN_STINGS` table. Weights are percent chances and sum to 100. The clips are `assets/join_stings/*.opus`; add one with `joinSting(file, weight, gainDb?)`. The older `assets/*.mp3` files are not played by the plugin; they are the default source directory for burg2's `goburg/scripts/encode_join_stings.sh`. Rules about who sets the odds are in burg memory `voice_intro_songs.md`.

### `external_plugins/discord` — `ignore` tool

`ignore(chat_id, message_id)` does nothing on Discord. It only checks the channel is allowed and returns, leaving a tool call in the transcript so the reply-coverage guard counts the message as deliberately handled.

### `external_plugins/discord` — friend bots

Upstream drops every bot-authored message. The fork's `messageCreate` handler always drops our own messages and lets through bots whose ids are in the `FRIEND_BOT_IDS` env var (comma-separated), so burg2 can talk to burg1.

### `external_plugins/discord` — presence tracking

With `ENABLE_PRESENCE_TRACKING=1`, `server.ts` requests the privileged `GuildPresences` intent and calls `setupPresenceTracking` (`presence.ts`), which records status and activity transitions to sqlite at `PRESENCE_DB_PATH` (default `/root/burg/presence.db`). Off by default, so the bot still boots when the portal toggle is off.

### `external_plugins/discord` — London-time timestamps

All timestamps surfaced **to the model** are Europe/London wall-clock with the UTC offset kept (`2026-06-09T20:45:13+01:00`, `+00:00` in winter), via `londonTs()` in `server.ts`. Covers the inbound `<channel>` meta `ts`, the five voice-event metas, and the `fetch_message`/`fetch_messages` history renders. Internal log files (channel log, voice utterance log) stay UTC. The offset is kept deliberately so the strings remain unambiguous, machine-parseable ISO-8601 across DST. Requested by stannaz 2026-06-09.

### `external_plugins/discord` — auto-rejoin flap damping

The voice `Disconnected` handler's auto-rejoin is rate-limited (`rejoinFlap` in `voice.ts`): a connection that was up ≥60s rejoins immediately as before, but repeated drops within the stable window back off linearly (1s → 2s → … → 10s) and then give up (map entry cleared so a later manual `voice_join` starts fresh). A manual `voice_join` during the backoff sleep supersedes the pending auto-rejoin. Fixes the unbounded teardown→rejoin cycle a flapping voice region could cause (review finding, 2026-06-09; schedule per stannaz).

### `external_plugins/discord` — reply context

Inbound messages now carry their reply target. When a Discord user replies to an earlier message, the `<channel>` notification gains three extra meta fields:

- `reply_to_id` — message id of the parent
- `reply_to_user` — username (or `me` if the bot was the parent author)
- `reply_to_preview` — single-line, ~80-char preview of the parent body (or `[attachment: name]` if the parent had no text)

A new tool, `fetch_message(chat_id, message_id)`, returns one specific message in full (no truncation) — used when the preview is insufficient or when grabbing a message by id from `fetch_messages` output. Attachments on a replied-to message are retrieved via the existing `download_attachment(chat_id, message_id)`.

### `external_plugins/discord` — voice loudness normalisation

`voice.ts` brings TTS and music to one target, `TARGET_LUFS` (-16), using a **static** gain per item and never dynamic loudnorm, so the level cannot ride or pump inside a track (per stannaz). Everything goes through `spawnPcm` (ffmpeg → raw 48k stereo PCM → `StreamType.Raw`) with the `NORM_LIMITER` brickwall on the end.

- **Files (`voice_play`, join stings):** `measureLoudness` analyses the first 60s once, then `playFileNow` applies `TARGET_LUFS - measured` as a flat `volume=` gain, plus the item's optional `gainDb` offset. A failed measurement plays at unity gain.
- **TTS:** edge-tts is a steady ~-21 LUFS, so it gets the fixed `TTS_GAIN_DB` boost with no analysis pass and replies stay instant.

**Knobs:** `TARGET_LUFS` for the overall level, `TTS_GAIN_DB` for speech against music, per-clip `gainDb` in the join-sting table.

### `external_plugins/discord` — leave voice when alone

`voice.ts` exports `registerVoiceAutoLeave(client)` (called once from `server.ts`, right after the join-sting `voiceStateUpdate` handler). It attaches its own `voiceStateUpdate` listener: whenever the bot is connected to a voice channel in a guild and that channel drops to **zero non-bot humans**, it arms a single 30s timer (`EMPTY_LEAVE_GRACE_MS`) and disconnects when it fires — unless someone (re)joins first, which cancels it. The countdown is re-evaluated on every voice-state change and re-checked at fire time, so a late rejoin always aborts the leave. `evaluateEmptyLeave` is also called at the end of `joinVoice`, so joining an *already-empty* channel starts the same countdown rather than sitting there forever. Timer state is a per-guild `emptyLeaveTimer` field on `GuildVoiceState`, cleared in `teardownState`. **Note:** this means the bot won't persist alone in an empty channel (e.g. a "radio" left running after everyone leaves) — it'll drop after 30s. Requested by hond + stannaz 2026-05-31.

### `external_plugins/discord` — continuous typing while cooking

`server.ts` replaces the single-shot `sendTyping()` (which Discord auto-expires after ~10s) with a per-channel refresh loop: `startTyping(chat_id, channel)` fires immediately on inbound then re-sends every `TYPING_REFRESH_MS` (8s), so "typing…" covers the whole time burg1 is cooking — not just the first 10s. The turn-end signal is **`SIGUSR2`** (SIGUSR1 is reserved by Node for the inspector), sent by the Claude Code Stop hook `scripts/stop_typing_signal.sh`, which reads the plugin pid from `/tmp/burg1_discord_plugin.pid` (written on gateway-ready). The plugin's `process.on('SIGUSR2', stopAllTyping)` clears every loop. Because the stop is bound to the *turn* (not to `reply`), an interim "give me a sec" message mid-turn does NOT end the indicator — the loop just re-asserts after Discord clears typing on send. `TYPING_MAX_MS` (5min) is a safety cap so a missed stop can't type forever. Helpers + state map sit by the other module-level maps; the Stop hook is wired in `.claude/settings.json`. Requested by stannaz 2026-07-13 (burg2 parity). **Note: the pidfile + Stop hook live outside this repo — reapply the settings.json hook + `stop_typing_signal.sh` if restoring on a fresh box.**

## Logs — where to look when something breaks

Read this *before* grepping the filesystem.

### Voice (transport + STT)

- `/root/burg/voice/logs/voice.log` — newline-delimited event log: voice join/leave, `speaking.start`, deepgram ws lifecycle, finalised transcripts. Source: `voice.ts` `logVoice()`.
- `/root/burg/voice/logs/voice-YYYY-MM-DD.tsv` — one row per finalised transcript with `gate_decision` (`forwarded` / `skipped_echo_match` / `skipped_no_wake_word`). **This is the file to read when "u didn't reply when i spoke"** — the row tells you what deepgram actually heard and whether it was forwarded to the session. TTS-out is appended to the same file with `direction=out`.

Both paths are hardcoded in `external_plugins/discord/voice.ts` (`LOG_DIR = '/root/burg/voice/logs'`). To relocate, change there — those two are the only writers.

### Channel-plugin event logs (`server.ts`)

Structured, append-only event logs written by `server.ts`'s `channelLog(file, line)` helper (distinct from the voice logs above and from MCP stderr). Each concern gets its own file under `CHANNEL_LOG_DIR = '/root/burg/logs'`; the helper takes a basename and writes `[ISO-timestamp] <line>\n`. It's best-effort — wrapped in a `try/catch{}`, so a write failure never breaks the handler (which is why a missing import once silently produced no file; see rule 9). Current files:

- `/root/burg/logs/join-sting.log` — one line per join sting: which clip was queued, which user triggered it, and the guild. Failures log too (`FAILED for <user>...`). Written by the join-sting `voiceStateUpdate` handler.

To add a new log, call `channelLog('<your-file>.log', '<message>')` from anywhere in `server.ts` — it creates the dir and file on first write. Add the new file to this list when you do.

### MCP server stderr (`server.ts`)

Claude Code captures the MCP server's stderr at:

- `/root/.cache/claude-cli-nodejs/-root-burg/mcp-logs-plugin-discord-discord/<launch-timestamp>.jsonl`

One file per Claude Code launch. Each line is `{debug|error, timestamp, sessionId, cwd}`. Use this for: gateway connect failures, login errors, voice_join failures, unhandled rejections, anything `process.stderr.write(...)` in `server.ts`. Newest file = current session (sort by mtime).

### Voice transcript debugging

Only transcripts containing the wake word ("burg", "burger", "burgers") are forwarded as a `<voice>` inbound (gate restored 2026-06-09); the echo-guard runs first so the bot doesn't loop on its own TTS. Every finalised transcript is TSV-logged either way.

If you spoke in VC and the bot didn't react:

1. Open today's `/root/burg/voice/logs/voice-YYYY-MM-DD.tsv`.
2. Find your row by timestamp.
3. Read the `text` column — that's what deepgram actually heard. If it's empty/garbled, that's an STT problem, not a gate problem.
4. Check `gate_decision`: `forwarded` = bot saw it and chose not to reply (judgement call); `skipped_no_wake_word` = nobody said "burg", so it never reached the session; `skipped_echo_match` = bot heard its own TTS. The `GateDecision` union in `voice.ts` is the full list.

### Old python bot (decommissioned)

The standalone `discord.py` voice bot was decommissioned 2026-05-10 and removed 2026-05-27. Its source + the old `bot.log` / `voice_bot.log` / `voice_log.tsv` logs are gone from `/root/burg/voice/`; the surviving source (`bot.py.legacy`, `menus.py`, helper scripts, operator `README.md`) now lives under `/root/burg/_archive/voice/`. Nothing in `/root/burg/voice/logs/` is from it any more — those are all current TS-bot logs.

## Working in this fork — rules for Claude

The whole point of the fork is that it stays cleanly rebaseable onto upstream. Rules for any change you make here:

1. **Touch as few files as possible.** Every line we add to a file that upstream also edits is a future merge conflict. Prefer adding new files over editing existing ones when it's a wash.
2. **Localise edits.** When you must edit an upstream file, group your additions in contiguous blocks (helper functions at the bottom, new tool case alongside existing ones) rather than scattering small one-liners through the file.
3. **No formatting churn.** Don't reflow, rename, or reorder upstream code. Diff noise = rebase pain. If upstream's style differs from yours, match upstream.
4. **Don't refactor upstream code to make your additions cleaner.** Adapt your code to upstream's shape, not the other way around.
5. **Keep new behaviour additive.** If a new field/tool/option can be ignored by callers that don't know about it, add it that way. Don't change existing tool signatures or notification shapes.
6. **Don't edit upstream `README.md` files.** Document fork-specific behaviour here in `FORK.md` — that way the upstream READMEs rebase clean.
7. **Document the diff here.** Anything you add to an upstream plugin gets a short bullet under "Custom additions" so the next rebase knows what to reapply if conflicts force a redo.
8. **No upstream-unrelated commits in upstream files.** Commits that touch upstream files should *only* contain the burg-specific change. Mixing in fixes you'd otherwise contribute upstream makes it harder to PR them later.
9. **Typecheck AND build before commit.** Discord plugin, from `external_plugins/discord`:
   - **Typecheck (the gate that catches the real bugs):** `bunx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types bun server.ts`. This is what catches an un-imported identifier (e.g. calling `appendFileSync` without importing it from `'fs'`) — `bun build` does **not**, because a bundler treats an unresolved free identifier as a global and emits no error. Skipping this once shipped a silently-no-op'd logger (the call threw `ReferenceError` straight into an empty `catch`). Run it.
   - **Build:** `bun install && bun build server.ts --target=bun --outdir=/tmp/x --external ffmpeg-static`. The `--external ffmpeg-static` is mandatory: prism-media references that optional native dep but we don't install it (the bot uses system ffmpeg), so a bare `bun build` fails on it regardless of your change.
   - Both must pass before you commit. Don't rationalise away an error as "unrelated" without proving it — that's how the import bug shipped.

## Rebasing onto upstream

```
git fetch upstream
git rebase upstream/main
```

Conflicts will almost always be in `external_plugins/discord/server.ts`. Resolve by reapplying the burg-specific block (look for additions referenced in "Custom additions" above) onto the new upstream code. Re-run the typecheck + build checks from rule 9 afterwards.
