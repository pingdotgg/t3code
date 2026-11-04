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

Preconditions: an open side chat. Pick a turn's scenario with `role=button[name='Choose side chat model']`; Replay offers `Showcase` (pauses on an approval), `Plan and reads`, `Write approval`, `Question` and `Multi turn`.

- **Send.** `preview_type` into `role=textbox[name='Side chat message']`, then `preview_click` `role=button[name='Send side chat message']`. The prompt and reply appear.
- **Queue.** On `Showcase`, wait for `Approve` to show, type a second prompt and `preview_click` `role=button[name='Queue message']`. The panel shows `1 queued` with `Send now`, `Edit queued message`, `Remove queued message`. (Without an approval, Ctrl/⌘-click `Steer message` queues.)
- **Stop.** With an empty draft during the run, `preview_click` `role=button[name='Stop']`. The timeline shows `Run interrupted · Stopped by user`; the queued message stays held until `Send now`.
- **Steer.** Choose Haiku 4.5 (via Settings, feature 8; the picker only lists the chat's provider). Send `Write a 600-word essay on the history of the clamp function across programming languages.`, type `Actually stop and just reply OK.`, then click `role=button[name='Steer message']` as soon as it appears (`preview_evaluate` `document.querySelector('[aria-label="Side chat"] button[aria-label="Steer message"]')?.click()`). The timeline shows a `Steer` tag and the reply `OK.`.

## Gotchas

- The send button's name changes with run state (`Send side chat message`, `Steer message`, `Queue message`, `Stop`). Read it just before clicking.
- A pending approval turns Steer into Queue. Replay scenarios end in under 2 s or stop at an approval, so steer needs Haiku.
