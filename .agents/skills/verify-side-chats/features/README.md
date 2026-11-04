# T3 Learn side-chat verification map

This directory is the maintained source for proving T3 Learn side chats in the web UI. Read the index, establish the Launch and Doctor preconditions in `../SKILL.md`, then drive features 1→11 in order.

## Baseline preconditions

- The parent thread has loaded the requested SHA in `/home/quokka/.t3/projects/t3-sidechat-qa` and paired the QA dev server.
- `preview_snapshot` shows the signed-in T3 Learn web app and a lesson with an assistant reply; use `Replay (dev)` for ordinary turns.
- Evidence is `~/side-chat-e2e/verify/<date>-<sha>/`; retain it during cleanup.

## Driving conventions

- Start each recipe from the state left by the previous feature, or reset to the same seeded lesson and document the reset.
- Pair every user action with the literal Browser-panel call and an observable result.
- Capture evidence the way `../SKILL.md` Evidence says. Don't count an entry point as verified because a different one worked.

## Features

- [1. Opening](./01-opening.md) — highlight a lesson reply and open a quoted side chat by button or shortcut.
- [2. Nesting](./02-nesting.md) — open a nested side chat and walk the breadcrumb levels.
- [3. Map](./03-map.md) — inspect and navigate the SideChatMap tree.
- [4. Done](./04-done.md) — finish or discard, prove the note, and reopen a finished chat.
- [5. Notes](./05-notes.md) — prove the next lesson message receives the side-chat note.
- [6. Auto-finish](./06-auto-finish.md) — lesson send finishes idle side chats but preserves an answering one.
- [7. Composer](./07-composer.md) — send, queue, steer, and stop in a side chat.
- [8. Settings](./08-settings.md) — configure model, explanation style, and skills.
- [9. Embed highlight](./09-embed-highlight.md) — ask from selected embed text, the corner button, full screen, and a nested embed.
- [10. HTML cards](./10-html-cards.md) — render a side-chat HTML card inline and full screen.
- [11. Photo enlarge](./11-photo-enlarge.md) — enlarge a side-chat photo and inspect the composer thumbnail path.
