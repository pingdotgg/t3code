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

- **Child.** Run the SKILL.md `select` snippet scoped to `[aria-label="Side chat"] [data-message-role="assistant"]` on a paragraph phrase, then `preview_click` `role=button[name='Ask in side chat']`. `[aria-label="Side chat path"]` reads `Lesson > <parent> > <phrase>`.
- **Up and down.** `preview_click` `[aria-label="Side chat path"] >> role=button >> nth=1`. The parent becomes the `aria-current` crumb and the child crumb stays; clicking the child crumb returns to it.
- **Reveal.** Call `preview_click` `{role:"button", name:"Show this highlight where it was asked"}`. The lesson scrolls to the original highlight; snapshot the lesson and child state.

## Gotchas

- Selecting the lesson while the side chat panel has focus can target the wrong viewport; snapshot the active panel first.
- A child cannot start until its parent has a settled assistant reply.
