# Nesting

A question selected inside a side chat opens a child side chat, and the breadcrumb lets the learner move between lesson, parent, and child.

## Sub-features

- `nested-open` asks about a side-chat reply.
- `nested-path` walks parent and child levels.
- `nested-reveal` returns to the quoted source.

## How to get to it (user POV)

- In the open `Side chat` timeline, select assistant text and choose **Ask in side chat**.
- Choose a breadcrumb in `Side chat path` to move up, then choose the child breadcrumb to move down.

## Driving it with the Browser panel

Preconditions: feature 1 has a side chat with a completed assistant reply.

- **Child.** Use `preview_evaluate` with `window.getSelection().selectAllChildren(document.querySelector('[data-side-chat-panel] [data-message-role="assistant"]'))` to select text inside the side-chat reply, then `preview_click` `{role:"button", name:"Ask in side chat"}`. `preview_snapshot` shows `Side chat path` with `Lesson` → parent label → child label and a fresh quoted excerpt; the timeline has `Side chat context` with `{role:"button", name:"Side chat context: show what the AI was given"}`.
- **Up and down.** Call `preview_click` on the parent breadcrumb `{role:"button", name:<parent label>}`; the child panel disappears. Call `preview_click` on `{role:"button", name:<child label>}`; the child composer and excerpt return.
- **Reveal.** Call `preview_click` `{role:"button", name:"Show this highlight where it was asked"}`. The lesson scrolls to the original highlight; snapshot the lesson and child state.

## Gotchas

- Selecting the lesson while the side chat panel has focus can target the wrong viewport; snapshot the active panel first.
- A child cannot start until its parent has a settled assistant reply.
