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

Preconditions: one open side chat with a user message and one side chat whose answer is visibly running.

- **Idle.** Call `preview_click` `{role:"textbox", name:"Lesson message"}`, `preview_type` `Next`, `preview_press` `Enter`; `preview_wait_for` the lesson run and `preview_snapshot`. The idle side chat no longer has an open state and its map row is done.
- **Busy.** Before the answer settles, snapshot the busy `{role:"region", name:"Side chat"}`; after the same lesson send, it still shows its running composer/status. When it settles, snapshot again and require a finished state.
- **Proof.** Reload with `preview_navigate` and snapshot the map; idle chat remains done, so the server-side auto-Done was applied.

## Gotchas

- An empty side chat with no user message can close without a note; use a message-bearing chat.
- Replay streams quickly; take the busy snapshot before it reaches its terminal state.
