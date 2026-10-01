# @t3tools/extension-files

First-party Files panel as an installable extension package. It renders the
workspace tree, name and file-contents search, text editing with revisioned
autosave, media, PDF and sandboxed HTML previews through the workspace
resource lease (HTML toggles to source, as in the native panel), and a
package-owned rendered-markdown preview — all through public contracts only
(`t3.workspace/tree`, `t3.workspace/files`, `t3.workspace/search`,
`t3.workspace/text-edits`, `t3.resources/lease`). It also provides
`t3.file/presentation@1.1.0`, the only first-party provider of it, so the
ordinary Files open path resolves here with no selection; a file link's
line opens the source at that line. It exposes an "Open in panel" file
action: `t3.ui/navigation` `openFile` (1.1.0, grant `t3.ui/navigation.open`)
opens the file in this view's thread where the host's own file links land,
presented by whichever provider the host selected for `t3.file/presentation`.
Reopening the file already shown there only focuses it. "Open in editor" uses
`t3.ui/editor@^1.1.0` (`t3.ui/editor.open` grant), resolving the path against
the view's scoped checkout. Local environments launch the saved editor;
remote and tunnel environments use the native SSH editor deep link, the
client's remote-capable editors, and the same saved preference. Choose another
editor from the picker; its remote menu includes the native SSH-key hint.
The control follows the native preview's environment visibility and stays
absent while checking support or on an older client. Capability answers are
cached briefly across remounts. The host's click-local opener preserves browser
activation; refusals appear inline. A missing SSH target never falls back to
launching an editor on the remote server. Remote URLs omit line and column
suffixes, like native; explicit-cwd SDK calls still execute in the environment.
For `.html`, `.htm`
and `.pdf` files, "Open file in preview browser" sends `openFile` with
`openIn: "browser"` (1.2.0), which opens the file in the thread's preview
browser, as native does. As there, the action shows only on a client with a
preview browser, which `getCapabilities` answers (`openFileInBrowser`, 1.2.0).
The pack probes for `openFile`, so it still loads on
a 1.0.0 host, which answers that it cannot open files. Breadcrumbs over the
tree snapshot, workspace link resolution in rendered markdown, centered line
reveals for search hits and `#L…`/`path:line` targets, and composer-mention
drags are package-owned; the drag payload uses the MIME the host
composer already claims. The toolbar's "Add to chat" goes through the
contract instead: `t3.composer/context@^1.2.0` `insertMention` (grant
`t3.composer/write`) appends the selected file's mention to the thread's
draft, byte-exact with the native panel's add-to-chat — a grant-free
capability probe gates the affordance, and every named denial (no client
transport, no thread scope, denied grant) shows inline at the click site.
`t3.composer/context` is a hard requirement: on a host without a matching
composer provider the whole package resolves `missing-api` — tree, editor
and search included — rather than mounting without Add to chat.

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
  file search `mod+f`, Open file in panel, Toggle rendered preview) bound through
  the view session, so the host's arbitration decides dispatch — user rules
  and native defaults outrank the plugin `defaultKey`s, which fire only while
  the panel is focused. Element-local keys (Escape) stay element-local.
- `t3.ui/notifications@^1.0.0` — under `t3.ui/notify`: a failed "Open in panel"
  toasts, matching the native panel's thread toast; every other status stays
  inline because the native panel keeps it there.
- `t3.ui/preferences@^1.0.0` — under `t3.ui/preferences.read`: the client's
  word-wrap setting (the one the native file preview honors) drives the editor
  and read-only source view, live over `subscribePreferences`. With
  `t3.ui/preferences.write` the toolbar's word-wrap toggle writes it back
  through `setPreferences`; the view changes only when the persisted value
  arrives. Without the read grant the toggle is hidden and wrapping stays as
  before. The HTML rendered/source choice rides the same preference
  (`renderBrowserFile`, 1.1.0, the native preview's own), so it carries across
  files, presentations and reloads; an HTML file loads nothing until the
  preference first answers. Hiding the file explorer does too
  (`fileExplorerOpen`, 1.2.0): a view reads it as it opens, as the native
  panel does, and each toggle writes it. Hosts without a key keep that choice
  per view.

Files the editor cannot open (past the edit bound, binary-adjacent,
non-UTF-8) show read-only. Where the host offers `ClientHost.codeView`, that
view is the host's native source preview — highlighted on the shared worker
pool and virtualized — with the same word-wrap setting and line reveals.
Hosts without the member keep a plain `<pre>`. Editable files use the same
Pierre editor as the native panel through the optional `ClientHost.codeView.Editor`
member, with no discovery or capability request. Hosts without that member stay
read-only. Edits autosave through the revisioned save coordinator after 500 ms,
using the unary CAS path
up to 24,000 bytes and the chunked resource CAS path up to 8 MiB. Dirty state,
conflict recovery and write grants stay with the Files session.

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
"Open in panel" needs a thread-scoped view context; a view opened without a
thread reports the refusal inline. It is not an external-editor launch.
