# Embed highlight

HTML embeds support asking about selected text, asking about the whole embed from its corner button, opening full screen, and nesting from an embed inside a side chat.

## Sub-features

- `embed-selection` asks about selected iframe text.
- `embed-corner` asks about the whole embed.
- `embed-fullscreen` opens the embed full screen and can ask there.
- `embed-nested` repeats the flow from a side-chat embed.

## How to get to it (user POV)

- In an HTML embed, select text and choose **Ask in side chat**.
- Hover/focus the embed corner and choose **Ask in side chat**.
- Choose **Open full screen**, then use the same corner action.
- Open an HTML embed in a side-chat reply and repeat.

## Driving it with the Browser panel

Preconditions: a newly generated HTML embed (embeds saved before APP-16/PR #32 have no bridge); wait for its iframe bridge.

- **Highlight.** `preview_evaluate` select text inside the iframe, `preview_snapshot`, then `preview_click` `{role:"button", name:"Ask in side chat"}` in `{role:"toolbar", name:"Selection actions"}`. The side chat opens with the embed title and selected text in its excerpt.
- **Corner.** `preview_click` the iframe's corner `{role:"button", name:"Ask in side chat"}`. Snapshot shows a side chat excerpt containing the embed title and text.
- **Full screen.** `preview_click` `{role:"button", name:"Open full screen"}`; snapshot shows the full-screen dialog/embed. Click its `{role:"button", name:"Ask in side chat"}` and require the dialog to close and the side chat excerpt to update.
- **Nested.** In a side-chat reply, repeat the iframe selection and `preview_click` the toolbar Ask button. `preview_snapshot` shows the child breadcrumb and embed excerpt.

## Gotchas

- Older published embeds lack the bridge and expose neither selection nor corner Ask; record the artifact age/build and fail that precondition.
- There may be multiple `Ask in side chat` buttons; scope the click to `Selection actions`, the embed frame wrapper, or full-screen dialog from the snapshot.
