# HTML cards in side chats

A side-chat reply containing an HTML card renders inline and opens the same card in a full-screen viewer.

## Sub-features

- `html-card-inline` renders the reply card in the side-chat timeline.
- `html-card-fullscreen` expands and closes the card without losing the reply.

## How to get to it (user POV)

- Ask a side-chat question that produces an HTML card (use Haiku if Replay has no HTML-card scenario).
- Choose **Open full screen** on the inline card, then close it.

## Driving it with the Browser panel

Preconditions: a side chat on Haiku 4.5 (feature 8). Replay has no HTML card scenario.

- **Inline.** Send `Draw me a tiny HTML diagram of clamp(x, lo, hi) as an inline card (use html_render). Keep it very small.` and wait for `role=button[name='Send side chat message']`. An `iframe` with the card's title sits inside `[aria-label="Side chat"]`.
- **Full screen.** `preview_click` `[aria-label="Side chat"] >> role=button[name='Open full screen']`. A dialog `Expanded <title> preview` shows the same iframe with zoom controls; `preview_press` `Escape` closes it and the inline card stays.

## Gotchas

- Do not substitute an embed in the lesson for an HTML card in a side-chat reply.
- A card that never arrives is a provider/scenario failure; record it in `result.md`.
