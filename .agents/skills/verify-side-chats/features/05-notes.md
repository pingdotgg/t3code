# Notes

A finished side chat writes a short note that goes with the next lesson message; the side chat's status line shows whether it was sent.

## Sub-features

- `note-ready` shows a ready note after Done.
- `note-delivery` sends it with the next lesson message.
- `note-reopen` reopens a finished chat when you ask in it.

## How to get to it (user POV)

- Finish a message-bearing side chat with **Done**.
- Send a new message in the lesson composer.
- Reopen the finished side chat to inspect its delivery status.

## Driving it with the Browser panel

Preconditions: feature 4 left a finished chat whose status reads `Goes with your next lesson message: <note>`.

- **Deliver.** `preview_type` `Continue` into `role=textbox[name='Message <lesson title>']` (for example `Message Replay: showcase`), then `preview_press` `Enter`.
- **Confirm.** Reload, open the chat from the map, then `preview_wait_for` `[aria-label="Side chat"] >> text=Sent to lesson` (30 s).
- **Reopen.** Send a message in that chat. The status line goes away and the reply arrives.

## Gotchas

- Notes are written even with Replay side chats; the note comes from the text-generation model. `Couldn't write the note` is a failure to record, not a pass.
- The lesson composer is named after the thread title, not `Lesson message`.
