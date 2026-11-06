# SideChatMap

The side-chat map shows the lesson and all nested side chats as an accessible tree and opens a selected node in the panel.

## Sub-features

- `map-open` opens the map toggle.
- `map-tree` exposes lesson and side-chat treeitems.
- `map-navigation` opens a node and returns to chat view.
- `map-sections` groups side chats under lesson headings and collapses a section.

## How to get to it (user POV)

- In an open side chat, choose **Side-chat map**.
- Choose **Fit** to fit the tree to the panel.
- Choose a node in the map, then choose **Side-chat map** again to return to chat.
- Open the command palette and choose **Toggle side-chat map** (source handle: `Command palette`, item title `Toggle side-chat map`).

## Driving it with the Browser panel

Preconditions: features 1–2 created a parent and child.

- **Open.** `preview_click` `role=button[name='Side-chat map']`. `[aria-label="Side chat map"]` has `role=tree` with one `treeitem` for the lesson (its title) and one per side chat, nested ones included.
- **Fit.** `preview_click` `role=button[name='Fit map to panel']`. The tree stays visible.
- **Command palette** (unverified, not yet driven live). `preview_press` `{key:"k", modifiers:["Control"]}` (`Meta` on macOS), `preview_type` `Toggle side-chat map`, then `preview_click` `role=option[name=/Toggle side-chat map/]`. The same tree appears.
- **Open node.** `preview_click` `role=treeitem[name=/^<label>/]`. The panel returns to chat with that child as the current breadcrumb; call `preview_snapshot` for proof.
- **Sections (unverified, not yet driven live).** Use a lesson reply containing `## Lesson 1: …`; with Replay, use a replay script whose reply has that heading. Open two side chats from that reply and confirm the map shows a `Lesson 1: …` section treeitem, with its side chats below it; click the section (or press Enter/Space) to collapse it and confirm `aria-expanded="false"` and the hidden count. A line that is only a bold title (`**L3: …**`) also starts a section; text after the bold (`**Q2: …** feedback`) does not. Driven live on 2026-11-05 (APP-58) against a QA copy of a real lesson: after clearing `sideChat.section` and restarting, the map showed an `L3: …` section holding its 23 side chats.

## Gotchas

- A fresh lesson with no side chats intentionally says `No side chats yet. Select text in a reply and choose Ask in side chat.`
- Treeitem names are lesson/side-chat labels; use `aria-description` from the snapshot when labels collide.
