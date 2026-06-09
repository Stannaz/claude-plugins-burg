# claude-plugins-burg — fork notes

Personal fork of [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official) for the burg deployment. The upstream `README.md` is left untouched on purpose; **everything fork-specific lives here.**

## Why this exists

Most of this marketplace is upstream-as-is. The fork is here so we can extend specific plugins (currently just `external_plugins/discord`) with features that aren't appropriate to upstream — features tightly coupled to how this particular Discord channel is used by the burg bot.

## Custom additions

### `external_plugins/discord` — London-time timestamps

All timestamps surfaced **to the model** are Europe/London wall-clock with the UTC offset kept (`2026-06-09T20:45:13+01:00`, `+00:00` in winter), via `londonTs()` in `server.ts`. Covers the inbound `<channel>` meta `ts`, the five voice-event metas, and the `fetch_message`/`fetch_messages` history renders. Internal log files (channel log, voice utterance log) stay UTC. The offset is kept deliberately so the strings remain unambiguous, machine-parseable ISO-8601 across DST. Requested by stannaz 2026-06-09.

### `external_plugins/discord` — auto-rejoin flap damping

The voice `Disconnected` handler's auto-rejoin is rate-limited (`rejoinFlap` in `voice.ts`): a connection that was up ≥60s rejoins immediately as before, but repeated drops within the stable window back off exponentially (5s → 10s → … capped 5min) and give up after 6 attempts (map entry cleared so a later manual `voice_join` starts fresh). A manual `voice_join` during the backoff sleep supersedes the pending auto-rejoin. Fixes the unbounded teardown→rejoin cycle a flapping voice region could cause (review finding, 2026-06-09).

### `external_plugins/discord` — reply context

Inbound messages now carry their reply target. When a Discord user replies to an earlier message, the `<channel>` notification gains three extra meta fields:

- `reply_to_id` — message id of the parent
- `reply_to_user` — username (or `me` if the bot was the parent author)
- `reply_to_preview` — single-line, ~80-char preview of the parent body (or `[attachment: name]` if the parent had no text)

A new tool, `fetch_message(chat_id, message_id)`, returns one specific message in full (no truncation) — used when the preview is insufficient or when grabbing a message by id from `fetch_messages` output. Attachments on a replied-to message are retrieved via the existing `download_attachment(chat_id, message_id)`.

### `external_plugins/discord` — voice loudness normalisation

`voice.ts` routes **both** TTS (edge-tts) and music (`voice_play` files) through a single ffmpeg `loudnorm` pass (`LOUDNORM_FILTER`, EBU R128, `I=-16` LUFS) and hands the resulting raw PCM to `@discordjs/voice` as `StreamType.Raw`. Without it, edge-tts (~-21 LUFS) is much quieter than mastered tracks (~-15 LUFS), so listeners had to ride the volume knob between my voice and songs. One-pass (not two-pass) loudnorm: it drains the pipe far faster than realtime, so it adds no audible startup delay, trading ~2 LU of accuracy on music — fine for live-queued audio. **To change the bot's overall level or the matching target, edit `LOUDNORM_FILTER` in `voice.ts` — it's the single knob.**


### `external_plugins/discord` — leave voice when alone

`voice.ts` exports `registerVoiceAutoLeave(client)` (called once from `server.ts`, right after the Ali-A `voiceStateUpdate` handler). It attaches its own `voiceStateUpdate` listener: whenever the bot is connected to a voice channel in a guild and that channel drops to **zero non-bot humans**, it arms a single 30s timer (`EMPTY_LEAVE_GRACE_MS`) and disconnects when it fires — unless someone (re)joins first, which cancels it. The countdown is re-evaluated on every voice-state change and re-checked at fire time, so a late rejoin always aborts the leave. `evaluateEmptyLeave` is also called at the end of `joinVoice`, so joining an *already-empty* channel starts the same countdown rather than sitting there forever. Timer state is a per-guild `emptyLeaveTimer` field on `GuildVoiceState`, cleared in `teardownState`. **Note:** this means the bot won't persist alone in an empty channel (e.g. a "radio" left running after everyone leaves) — it'll drop after 30s. Requested by hond + stannaz 2026-05-31.

## Logs — where to look when something breaks

Read this *before* grepping the filesystem.

### Voice (transport + STT)

- `/root/burg/voice/logs/voice.log` — newline-delimited event log: voice join/leave, `speaking.start`, deepgram ws lifecycle, finalised transcripts. Source: `voice.ts` `voiceLog()`.
- `/root/burg/voice/logs/voice-YYYY-MM-DD.tsv` — one row per finalised transcript with `gate_decision` (`forwarded` / `skipped_echo_match` / `skipped_cooldown` / etc). **This is the file to read when "u didn't reply when i spoke"** — the row tells you what deepgram actually heard and whether it was forwarded to the session. TTS-out is appended to the same file with `direction=out`.

Both paths are hardcoded in `external_plugins/discord/voice.ts` (`LOG_DIR = '/root/burg/voice/logs'`). To relocate, change there — those two are the only writers.

### Channel-plugin event logs (`server.ts`)

Structured, append-only event logs written by `server.ts`'s `channelLog(file, line)` helper (distinct from the voice logs above and from MCP stderr). Each concern gets its own file under `CHANNEL_LOG_DIR = '/root/burg/logs'`; the helper takes a basename and writes `[ISO-timestamp] <line>\n`. It's best-effort — wrapped in a `try/catch{}`, so a write failure never breaks the handler (which is why a missing import once silently produced no file; see rule 9). Current files:

- `/root/burg/logs/alia-join.log` — one line per Ali-A VC-join intro: which channel was joined, which user triggered it, and the guild. Failures log too (`FAILED for <user>...`). Written by the temporary Ali-A `voiceStateUpdate` handler (self-expires 2026-06-12).

To add a new log, call `channelLog('<your-file>.log', '<message>')` from anywhere in `server.ts` — it creates the dir and file on first write. Add the new file to this list when you do.

### MCP server stderr (`server.ts`)

Claude Code captures the MCP server's stderr at:

- `/root/.cache/claude-cli-nodejs/-root-burg/mcp-logs-plugin-discord-discord/<launch-timestamp>.jsonl`

One file per Claude Code launch. Each line is `{debug|error, timestamp, sessionId, cwd}`. Use this for: gateway connect failures, login errors, voice_join failures, unhandled rejections, anything `process.stderr.write(...)` in `server.ts`. Newest file = current session (sort by mtime).

### Voice transcript debugging

The wake-word gate was removed 2026-05-13 — every finalised transcript is now forwarded as a `<voice>` inbound (echo-guard still applies so the bot doesn't loop on its own TTS).

If you spoke in VC and the bot didn't react:

1. Open today's `/root/burg/voice/logs/voice-YYYY-MM-DD.tsv`.
2. Find your row by timestamp.
3. Read the `text` column — that's what deepgram actually heard. If it's empty/garbled, that's an STT problem, not a gate problem.
4. Check `gate_decision`: `forwarded` = bot saw it and chose not to reply (judgement call); `skipped_echo_match` = bot heard its own TTS; otherwise see the `GateDecision` union in `voice.ts`.

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
