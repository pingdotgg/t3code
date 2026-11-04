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

Preconditions: feature 4 left a finished chat whose status reads `Goes with your next lesson message: <note>`.

- **Deliver.** `preview_type` `Continue` into `role=textbox[name='Message <lesson title>']` (for example `Message Replay: showcase`), then `preview_press` `Enter`.
- **Confirm.** `preview_wait_for` text `Sent to lesson` (30 s). Reopen the chat from the map after a reload and check that the status still reads `Sent to lesson: <note>`.

## Gotchas

- Notes are written even with Replay side chats; the note comes from the text-generation model. `Couldn't write the note` is a failure to record, not a pass.
- The lesson composer is named after the thread title, not `Lesson message`.
