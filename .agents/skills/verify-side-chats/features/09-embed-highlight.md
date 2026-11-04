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

Preconditions: an HTML embed with readable text, made after PR #32 (QA has the `APP-16 QA embed lesson` lesson).

- **Highlight.** `preview_click` with `locator` `role=region[name='Conversation'] >> iframe[title='<title>'] >> internal:control=enter-frame >> p >> nth=0` and `clickCount: 3`. A text button `Ask in side chat` appears over the selection; `preview_click` `role=button[name='Ask in side chat'] >> text=Ask in side chat`. The path reads `Lesson > <selected text…>`.
- **Corner** (unverified, not yet driven live). `preview_hover` the embed, then `preview_click` the icon-only `role=button[name='Ask in side chat']` in the embed's top corner (not the `text=` one). The path gains the embed title.
- **Full screen.** Hover an embed or card, `preview_click` `role=button[name='Open full screen']`, then the dialog's `role=dialog >> role=button[name='Ask in side chat']`. The dialog closes and a side chat opens quoting the embed title and its visible text.
- **Nested.** Do **Full screen** on a card inside a side chat (feature 10's card). The path gains a third crumb.

## Gotchas

- Embeds published before PR #32 have no bridge, so they show no corner button and highlights in them do nothing. Record the embed's age instead of failing the feature.
- Text in SVG does not select by clicking. Use an HTML text element.
- The icon-only corner button and the text button share the name `Ask in side chat`. Scope the click with `text=` or `role=dialog`.
