# HTML cards in side chats

A side-chat reply containing an HTML card renders inline and opens the same card in a full-screen viewer.

## Sub-features

- `html-card-inline` renders the reply card in the side-chat timeline.
- `html-card-fullscreen` expands and closes the card without losing the reply.

## How to get to it (user POV)

- Ask a side-chat question that produces an HTML card (use Haiku if Replay has no HTML-card scenario).
- Choose **Open full screen** on the inline card, then close it.

## Driving it with the Browser panel

Preconditions: a side chat is open; a provider response contains an HTML card. Replay `showcase` has no HTML-card scenario, so use Claude Haiku and record that provider.

- **Inline.** `preview_wait_for` the side-chat reply and `preview_snapshot`; the card is visible inside `{role:"region", name:"Side chat"}` with its iframe title.
- **Expand.** `preview_click` `{role:"button", name:"Open full screen"}` scoped to that card. Snapshot shows the full-screen HTML dialog and its title.
- **Close.** `preview_press` `Escape` (or click the dialog close control), then `preview_snapshot`; the inline card remains in the side-chat reply and the full-screen dialog is gone.

## Gotchas

- Do not substitute an embed in the lesson for an HTML card in a side-chat reply.
- A card that never arrives is a provider/scenario failure; record it in `result.md`.
