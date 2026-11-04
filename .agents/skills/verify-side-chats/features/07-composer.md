# Composer

The side-chat composer sends a message, queues a message behind a running turn, steers a running turn, and stops it.

## Sub-features

- `composer-send` sends with the side-chat composer.
- `composer-queue` queues while answering.
- `composer-steer` steers while answering.
- `composer-stop` interrupts the run.

## How to get to it (user POV)

- Type into **Side chat message** and send with Enter or **Send side chat message**.
- While answering, send with the alternate shortcut for **Queue message** or **Steer message**.
- Choose **Stop** while the side chat is running.

## Driving it with the Browser panel

Preconditions: an open side chat with a working provider.

- **Send.** `preview_click` `{role:"textbox", name:"Side chat message"}`, `preview_type` `Explain this`, `preview_press` `Enter`; `preview_wait_for` a new timeline item and snapshot. The prompt and reply appear in the side chat.
- **Queue.** Start another turn, then `preview_type` a second prompt and `preview_click` `{role:"button", name:"Queue message"}` (or use the configured alternate key). Snapshot shows a queued item and `QueuedRunsControl` output.
- **Steer.** During a running turn, `preview_click` `{role:"button", name:"Steer message"}` after typing a replacement. Snapshot shows the new prompt as the active dispatch.
- **Stop.** During a running turn, `preview_click` `{role:"button", name:"Stop"}`. `preview_wait_for` the running indicator to disappear; snapshot shows the interrupted/settled turn and no Stop button.

## Gotchas

- The send button changes its accessible name with run state; always snapshot immediately before clicking.
- Queueing is disabled while starting or when a pending approval/input owns the composer.
