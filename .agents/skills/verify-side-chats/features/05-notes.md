# Notes

A completed side chat writes a concise note that the next lesson message receives and exposes in the side-chat status/context UI.

## Sub-features

- `note-ready` shows a ready note after Done.
- `note-delivery` sends it with the next lesson message.
- `note-marker` makes the handoff observable in the lesson timeline.

## How to get to it (user POV)

- Finish a message-bearing side chat with **Done**.
- Send a new message in the lesson composer.
- Reopen the finished side chat to inspect its delivery status.

## Driving it with the Browser panel

Preconditions: a finished side chat with a generated note; use Haiku if Replay only produces `No note needed`/`Couldn't write the note`.

- **Ready.** `preview_click` `{role:"button", name:"Done", exact:true}`; `preview_wait_for` the side-chat status and `preview_snapshot`. It reads `Goes with your next lesson message: <note>`.
- **Deliver.** `preview_click` the lesson composer `{role:"textbox", name:"Lesson message"}`, `preview_type` `Continue`, then `preview_press` `Enter`. Snapshot the lesson timeline; it shows the next run/context divider with the side-chat note or `Adding side-chat note…` while waiting. Expand `{role:"button", name:"Side chat context: show what the AI was given"}` to inspect the handoff text.
- **Confirm.** Reopen the side chat via its map treeitem or mark and snapshot. Its status reads `Sent to lesson: <note>`; this second view proves delivery rather than a local draft.

## Gotchas

- Notes are optional and asynchronous; the 15-second `SIDE_CHAT_WAIT_CAP_MS` is a deadline, not a sleep to add to the recipe.
- A failed note is visible as `Couldn't write the note`; record that reason instead of claiming delivery.
