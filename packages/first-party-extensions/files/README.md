# @t3tools/extension-files

First-party Files panel as an installable extension package. It renders the
workspace tree, name and file-contents search, text editing with revisioned
autosave, media previews through the workspace resource lease, and a
package-owned rendered-markdown preview — all through public contracts only
(`t3.workspace/tree`, `t3.workspace/files`, `t3.workspace/search`,
`t3.workspace/text-edits`, `t3.resources/lease`). It also provides
`t3.file/presentation` so the ordinary Files open path can select it, and
exposes an "Open in…" file action that resolves through whichever provider
the host selected for that API (grant `t3.file/open`). Breadcrumbs over the
tree snapshot, workspace link resolution in rendered markdown, centered line
reveals for search hits and `#L…`/`path:line` targets, and composer-mention
drags are package-owned; the drag payload uses the MIME the host
composer already claims. The toolbar's "Add to chat" goes through the
contract instead: `t3.composer/context@^1.1.0` `insertMention` (grant
`t3.composer/write`) appends the selected file's mention to the thread's
draft, byte-exact with the native panel's add-to-chat — a grant-free
capability probe gates the affordance, and every named denial (no client
transport, no thread scope, denied grant) shows inline at the click site.

UI contracts (`t3.ui/*`, adopted opportunistically — every one degrades
without its grant or provider):

- `t3.ui/theme@^1.0.0` — under `t3.ui/theme.read`: `getTokens` resolves the
  host's effective theme (stored preference, session overlay, or external
  preview — the provider folds them) and `subscribeState` re-reads on every
  transition. Resolved values land on the view root as `--t3-files-*`
  variables ahead of each style's legacy `var()` chain; a denied read or a
  lost stream clears them, so an installation without the grant — or after
  losing it — renders the pre-contract appearance unchanged.
- `t3.ui/keybindings@^1.0.0` — under `t3.ui/keybindings`: the panel's actions
  register as a `surface`-scope command set (Refresh files `mod+r`, Focus
  file search `mod+f`, Open file in…, Toggle rendered markdown) bound through
  the view session, so the host's arbitration decides dispatch — user rules
  and native defaults outrank the plugin `defaultKey`s, which fire only while
  the panel is focused. Element-local keys (Escape) stay element-local.
- `t3.ui/notifications@^1.0.0` — under `t3.ui/notify`: a failed "Open in…"
  toasts, matching the native panel's thread toast; every other status stays
  inline because the native panel keeps it there.

The surface declares no `capabilities` — that field gates mounting on host
services, and these adoptions ride on `requires` + install grants instead.

Build and check with the SDK CLI (`npm run build`, `npm run check`), then
install the generated `.t3-extension/` directory through the normal installer.
The audit (`npm run audit`, shared script at `../scripts/audit-imports.mjs`)
proves the shipped bundle has no app-private imports.

Known limits (named in the UI): the rendered markdown view is a deliberately
small CommonMark/GFM subset — no raw-HTML passthrough, tables, or workspace
image resolution; task checkboxes are read-only. Contents search reports the
contract's match lines and truncation verbatim. The breadcrumb root is
labeled "Workspace" — no contract reports the project title to this view —
and crumbs are non-navigable when the selected path is host-absolute.
"Open in…" resolves the presentation descriptor the selected
provider returns; mounting that surface is the host's concern.
