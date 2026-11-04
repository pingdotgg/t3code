# Opening

Opening a side chat from a lesson highlight keeps the selected excerpt and its surrounding context in the side-chat panel.

## Sub-features

- `opening-selection` opens from the text-selection toolbar.
- `opening-shortcut` opens from the registered Ask-in-side-chat selection shortcut.
- `opening-panel` shows the quoted excerpt and context divider.

## How to get to it (user POV)

- Select words in an assistant lesson reply and choose **Ask in side chat**.
- With the selection still live, press the configured Ask-in-side-chat shortcut (`Mod+Alt+S`).

## Driving it with the Browser panel

Preconditions: a lesson with a finished assistant reply (the QA lesson `Replay: showcase` works).

- **Selection.** Select a fresh phrase with the SKILL.md `select` snippet, then `preview_click` `role=button[name='Ask in side chat']`. The `Side chat` region opens; `[aria-label="Side chat path"]` reads `Lesson > <phrase>` and the panel asks `What do you want to know about “<phrase>”?`.
- **Shortcut.** Select another fresh phrase, blur the composer (`document.activeElement.blur()` in the same snippet), then `preview_press` `s` with modifiers `["Control","Alt"]` (`Meta` on macOS). The path reads `Lesson > <new phrase>`.
- **Proof.** `preview_snapshot` with `save: true`; copy the PNG into the evidence directory.

## Gotchas

- Selecting a whole element (`selectAllChildren`, triple-click) or list-item text shows no toolbar. Select part of one paragraph text node.
- A phrase inside an existing side chat's highlight reopens that chat instead of opening a new one. Pick text nobody has asked about yet.
- Upstream's `/side` and `/btw` are hidden in T3 Learn (APP-3), so they are not entry points.
- With Replay the context divider reads `Side chat context (summary unavailable)`. That is expected, not a failure.
