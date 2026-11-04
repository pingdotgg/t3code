# SideChatMap

The side-chat map shows the lesson and all nested side chats as an accessible tree and opens a selected node in the panel.

## Sub-features

- `map-open` opens the map toggle.
- `map-tree` exposes lesson and side-chat treeitems.
- `map-navigation` opens a node and returns to chat view.

## How to get to it (user POV)

- In an open side chat, choose **Side-chat map**.
- Choose **Fit** to fit the tree to the panel.
- Choose a node in the map, then choose **Side-chat map** again to return to chat.
- Open the command palette and choose **Toggle side-chat map** (source handle: `Command palette`, item title `Toggle side-chat map`).

## Driving it with the Browser panel

Preconditions: features 1–2 created a parent and child.

- **Open.** `preview_click` `role=button[name='Side-chat map']`. `[aria-label="Side chat map"]` has `role=tree` with one `treeitem` for the lesson (its title) and one per side chat, nested ones included.
- **Fit.** Call `preview_click` `{role:"button", name:"Fit map to panel"}`. Snapshot shows `aria-pressed="true"` and the tree remains visible.
- **Command palette.** `preview_press` `Meta+K` on macOS or `Control+K` elsewhere, `preview_type` `Toggle side-chat map`, then `preview_click` `{role:"option", name:"Toggle side-chat map"}`. The same `Side chat map` tree appears.
- **Open node.** `preview_click` `role=treeitem[name=/^<label>/]`. The panel returns to chat with that child as the current breadcrumb; call `preview_snapshot` for proof.

## Gotchas

- A fresh lesson with no side chats intentionally says `No side chats yet. Select text in a reply and choose Ask in side chat.`
- Treeitem names are lesson/side-chat labels; use `aria-description` from the snapshot when labels collide.
