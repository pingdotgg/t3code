# Auto-finish

Sending a lesson message finishes open side chats that have messages, while a side chat that is still answering remains open until it settles.

## Sub-features

- `auto-finish-idle` closes an idle message-bearing side chat on lesson send.
- `auto-finish-busy` preserves a side chat with an active answer.

## How to get to it (user POV)

- Leave a side chat open after it has a message.
- Send a message from the lesson composer.
- While another side chat is answering, send from the lesson and inspect both panels.

## Driving it with the Browser panel

Preconditions: a second side chat left open with a sent message and a finished reply (not Done).

- **Idle.** Send a lesson message (feature 5's **Deliver** does this). Open the second chat from the map: it now shows a status line (`Goes with…`, `Sent to lesson…`, `No note needed` or `Couldn't write the note`), so the lesson send finished it. A `Couldn't write the note` here still passes auto-finish; record it in `result.md` as a notes failure to look into.
- **Busy** (unverified, not yet driven live). Start a long Haiku turn in a side chat (feature 7 **Steer** prompt), and while it shows `Working`, send a lesson message. The busy chat keeps running with no status line, then finishes after its reply settles.

## Gotchas

- An empty side chat with no user message can close without a note. Use a chat that has a message.
- Replay turns finish in about 2 s, too fast to catch the busy case. Use Haiku for **Busy**.
