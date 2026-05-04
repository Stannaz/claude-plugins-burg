# claude-plugins-burg — fork notes

Personal fork of [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official) for the burg deployment. The upstream `README.md` is left untouched on purpose; **everything fork-specific lives here.**

## Why this exists

Most of this marketplace is upstream-as-is. The fork is here so we can extend specific plugins (currently just `external_plugins/discord`) with features that aren't appropriate to upstream — features tightly coupled to how this particular Discord channel is used by the burg bot.

## Custom additions

### `external_plugins/discord` — reply context

Inbound messages now carry their reply target. When a Discord user replies to an earlier message, the `<channel>` notification gains three extra meta fields:

- `reply_to_id` — message id of the parent
- `reply_to_user` — username (or `me` if the bot was the parent author)
- `reply_to_preview` — single-line, ~80-char preview of the parent body (or `[attachment: name]` if the parent had no text)

A new tool, `fetch_message(chat_id, message_id)`, returns one specific message in full (no truncation) — used when the preview is insufficient or when grabbing a message by id from `fetch_messages` output. Attachments on a replied-to message are retrieved via the existing `download_attachment(chat_id, message_id)`.

When the inbound message is a reply, the rendered TUI line is also prefixed with `↳ replying to <user>: <preview>\n` so the operator sees the reply target in their terminal alongside the message body. The structured `reply_to_*` meta fields stay populated regardless.

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
9. **Test with `bun build`.** Discord plugin: `cd external_plugins/discord && bun install && bun build server.ts --target=bun --outdir=/tmp/x` should succeed before commit.

## Rebasing onto upstream

```
git fetch upstream
git rebase upstream/main
```

Conflicts will almost always be in `external_plugins/discord/server.ts`. Resolve by reapplying the burg-specific block (look for additions referenced in "Custom additions" above) onto the new upstream code. Re-run the `bun build` check afterwards.
