# Opening

Opening a side chat from a lesson highlight keeps the selected excerpt and its surrounding context in the side-chat panel.

## Sub-features

- `opening-selection` opens from the text-selection toolbar.
- `opening-shortcut` opens from the registered Ask-in-side-chat selection shortcut.
- `opening-slash` opens `/side` or `/btw` from the lesson composer.
- `opening-panel` shows the quoted excerpt and context divider.

## How to get to it (user POV)

- Select words in an assistant lesson reply and choose **Ask in side chat**.
- With the selection still live, press the configured Ask-in-side-chat shortcut (`Mod+Alt+S`, shown in onboarding/keybindings).
- Type `/side` or `/btw` in the lesson composer and submit it.

## Driving it with the Browser panel

Preconditions: a signed-in lesson reply is visible and side chats are offered.

- **Selection.** Select text with `preview_evaluate` (`window.getSelection().selectAllChildren(document.querySelector('[data-assistant-citation-viewport="true"] [data-message-role="assistant"]'))`), then `preview_snapshot`; call `preview_click` on the button `{role:"button", name:"Ask in side chat"}`. A `{role:"region", name:"Side chat"}` opens, its `{role:"button", name:"Show this highlight where it was asked"}` contains the excerpt, and the timeline shows `Side chat context`; `preview_click` `{role:"button", name:"Side chat context: show what the AI was given"}` and snapshot the quoted opening context.
- **Shortcut.** Re-select a shorter phrase with `preview_evaluate`, then `preview_press` `Meta+Alt+S` on macOS or `Control+Alt+S` elsewhere. `preview_snapshot` shows the same `Side chat` region and quoted excerpt.
- **Slash entry.** `preview_click` `{role:"textbox", name:"Lesson message"}`, `preview_type` `/side`, `preview_press` `Enter`; snapshot shows a new `Side chat` panel with the prompt. Repeat with `/btw` if the first command is supported.
- **Proof.** Call `preview_snapshot` with the feature screenshot and ARIA paths. The excerpt and divider must remain after `preview_wait_for` the panel, not only during the starting state.

## Gotchas

- The source selector must be a real assistant message; if `[data-assistant-citation-viewport="true"] [data-message-role="assistant"]` is absent, fail with the missing lesson-reply precondition.
- A streaming reply blocks Ask; wait for the completed reply.
- Opening summaries may show `The lesson summary is unavailable.` with Replay; use Haiku to prove generated opening text.
