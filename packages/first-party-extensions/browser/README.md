# @t3tools/extension-browser

First-party Browser panel (`t3.browser`) as an installable SDK extension,
with a host presentation lease for the live engine view.

The panel renders through public contracts only:

- `t3.browser/sessions` (brokered, `requires`) opens/navigates/drives the
  session; the `events` stream is the only source of engine and navigation
  truth — receipts are dispatch records, never load confirmations.
- `t3.browser/surface` (host capability on `ClientHost.browserSurface`,
  reached through `useBrowserSurfaceSlot`) composites the native webview
  into the plugin-owned slot element. Both `t3.browser/sessions` and
  `t3.browser/surface` installation grants are required; denials and
  unsupported clients (`desktop-required`) render as named states, never
  silence.
- Workspace `.html`/`.htm`/`.pdf` paths typed in the address bar (or
  restored as `relativePath`) open in `t3.browser/view`. The pack does not
  provide `t3.file/presentation`: that API opens any file, so a second
  provider next to t3.files would make every consumer need an explicit
  selection. The view mints a
  `t3.resources/lease` `workspace-file` URL (`t3.workspace/resources` grant),
  resolves it on the document's own origin and opens it in a session; sibling
  assets load under the same token. The token lives 1 h, so the view keeps the
  workspace path — never the minted URL — in history and restore state, and
  Reload re-mints. A client not served from the environment's HTTP origin
  (the desktop `t3code://` renderer, a foreign web origin) gets a named
  state: the SDK does not tell plugins the environment origin.
- `t3.browser/sessions` page verbs (`pageControls.ts`, `pageMenu.tsx`) —
  Back/Forward/Reload in the header, and a page menu with Hard reload,
  Appearance (System/Light/Dark), the zoom row and Mute, all sent to the
  desktop engine host that owns the session and fenced on its engine
  generation. Zoom `mod+=`/`mod+-`/`mod+0` and the menu's −/+ step the
  contract ladder; the zoom select jumps to any ladder factor in one `zoom`
  call. A transient pill shows the engine-reported factor when it changes.
  The tab strip shows a speaker toggle while a page plays audio. Controls
  disable with the reason on screen when the engine is `unavailable`
  (`desktop-required`), `recovering` or `crashed`; once recovery is
  exhausted, Reload reopens the page in a fresh session. Rejected,
  unanswered (`unknown`) and refused commands name their outcome inline.
  Every value shown is engine-reported; nothing applies optimistically.
- DevTools (`t3.browser/sessions@1.1.0` `openDevTools` / `closeDevTools`,
  which also need the installation's own `t3.browser/devtools` grant — the
  sessions and operate grants say nothing about DevTools). They act only on
  sessions this installation opened. The page menu's Open/Close DevTools
  item follows the session's engine-reported `devToolsOpen` and stays
  disabled until the engine reports it. Refusals are named inline: missing
  grant (`grant-denied`), a session the panel did not open (`not-owned`), no
  desktop host (`desktop-required`), no engine attached to this page yet
  (`no-attached-engine`), or an engine that cannot toggle DevTools
  (`engine-unsupported`).
- Native picture-in-picture — the page menu's "Pop out" toggle sends
  `t3.browser/sessions` `setPictureInPicture` to the owning desktop engine
  host, which shows the page in its floating PiP window. It needs its own
  `t3.browser/picture-in-picture` grant (page pixels leave the panel);
  `t3.browser/operate` neither confers nor is needed for it. The toggle's
  state is the session's engine-reported `pictureInPicture`, delivered by the
  events stream like every other page field. A missing grant
  (`grant-denied`), no desktop host (`desktop-required`) and a recovering or
  crashed guest name their refusal inline. The native in-app mini-player
  (the preview floating over the chat) is not available: it needs a host
  placement that floats a plugin view outside its panel.
- `t3.browser/profiles` (`profiles.ts`, `profileMenu.tsx`) — the page
  menu's profile group: the session's profile name ("Removed profile" when it
  was deleted), "Open page in" another profile, Clear cookies, Clear cache,
  and "Import cookies…" from a browser installed on the desktop. Each rides
  its own grant and holding one implies none of the others:
  `t3.browser/profiles` (list + open in a profile, on top of
  `t3.browser/sessions` + `t3.browser/operate`), `t3.browser/clear-cookies`,
  `t3.browser/clear-cache`, `t3.browser/import-cookies`. A profile is fixed
  when a session opens, so switching opens the page in a new session; a page
  reopened after its session died keeps that session's profile. The desktop
  engine host runs all of it: elsewhere, or without a grant, the action names
  `desktop-required` or the missing grant on the status line. Clearing
  signs every page in that profile out, as the native menu does. Import
  targets the session's profile and the desktop asks the user to confirm
  before reading the other browser; only counts come back. Importing into a
  new profile stays in Settings → Integrations → Browser. The badge and the
  menu share one profile list: a host serving `t3.browser/profiles` 1.1.0
  pushes each rename, deletion or default change over its `changes` stream;
  an older host is read again when the panel is shown or the menu opens.
  With no desktop connected, or a refused stream, the menu names why
  (`desktop-required` or the missing grant) rather than showing an old list.
- `t3.browser/capture` (host capability on `ClientHost.browserCapture`;
  `t3.browser/sessions` + `t3.browser/capture` grants) backs the header's
  two capture buttons: screenshot the page, or pick an element with the
  desktop's in-page picker and keep its crop. The host uploads the PNG to the
  environment's attachment store and returns only an `artifactRef`, which
  `t3.composer/context` `insertImage` (`t3.composer/write`) attaches to this
  thread's draft; pixels never ride an API payload. Capturing needs the
  session shown on a desktop client; elsewhere the buttons stay disabled.
  A page capture's "Screenshot saved" toast offers native's Copy path,
  Reveal and Copy image through the capability's artifact actions
  with the original sessions and capture grants,
  which act on the copy the desktop saved beside native screenshots; the
  toast stays open and a copy reads "Copied!" briefly
  (`t3.ui/notifications` 1.1.0 `keepOpen` actions and `flashAction`). The
  pack still requires only notifications `^1.0.0`: it probes the host's
  version, and offers the actions only for a capture the desktop saved;
  otherwise the plain toast goes out.
  On a 1.3.0 capture host, an element pick also returns a client-local
  `annotationRef`. `t3.composer/context` 1.3.0 `insertPreviewAnnotation`
  consumes that reference through the same client connection and adds the
  native annotation chip and optional crop together. Elements, regions,
  drawings, styles and comments stay on the host; even a failed crop keeps
  the annotation. This path keeps the crop local rather than uploading an
  attachment that would immediately be released. Cmd/Ctrl+Enter in the native
  picker asks the host to send; the extension cannot request a send through
  the composer API. Handles are consumed once, scoped to the installation
  and thread, and discarded on cancellation or after five minutes. Older
  hosts keep the crop-only path.
  On a capture 1.2.0 desktop host, Shift-click starts the native recorder
  (`t3.browser/recording` grant and a live user click). Click again to stop
  and save the video locally, with no upload or attachment size limit.
  The recording indicator follows the native recorder, including recordings
  started outside the pack. The desktop host also owns an always-visible native
  recording control, independent of what the pack renders; stopping stays available
  when the page is hidden. Unloading an installation saves and shows the native toast.
  The "Recording saved" toast offers Reveal as its primary action and Copy path
  with the recording artifact-actions grant. Recording refs are host-local, not
  pending composer attachments. The native toolbar has no recording-upload action,
  so the SDK offers none; native automation's explicit transfer remains separate.
  Older hosts and web clients do not offer recording.
- `t3.ui/panels` 1.1.0 `getBrowserMiniPlayer` and `setBrowserMiniPlayer`
  drive the native floating preview through the client-provider seam.
  The header’s “Float preview over chat” action and closing the Browser panel
  float its live page. Reopening or returning from the player reclaims the
  same session in the originating extension panel, without a superseded
  notice or a new tab. The player hides while that panel is open, including
  while its surface acquisition is pending. Dragging, resizing and closing
  use the existing player. The button follows local host state, including
  closing the player from its own X, without requests on tab switches.
  It is disabled for missing web contents or an unreachable page and omitted
  on web clients and hosts without floating-preview support. The mutation
  requires both `t3.ui/panels` and `t3.browser/sessions` and a session held by
  this installation; it does not close an unrelated panel.
- `t3.browser/local-servers` (`t3.browser/read-local-servers` grant) fills
  the empty state's "Local servers" section while it is visible. Loopback
  URLs open as-is — unlike the native panel they are not re-mapped to a
  remote environment's host, and the section says so.
- `t3.browser/history` (`t3.browser/read-history` grant to list;
  `t3.browser/read-history` + `t3.browser/record-history` to record, title,
  or remove) is the project's URL history — the same per-project list the
  native preview keeps on this client, so a visit in one thread is a recent
  in every thread of the project and survives the thread ending. An address
  the engine accepted (typed, a recent, a local server) is recorded; a
  loaded page's title enriches its entry; the recents "×" removes it.
  Workspace-file presentations never enter history. Until the list arrives,
  and whenever the contract cannot serve it (denied grant, no connected
  provider), the recents show this view's own saved list and a note names
  why. When the full list of long URLs is larger than one answer can carry,
  the host returns the most recent entries that fit and the recents note
  that the list was truncated.
- Favicons — the native favicon row, captured tier first. The desktop engine
  host reports each page's favicon; the server keeps the bytes as a bounded
  per-project asset and a session carries only its `faviconRef`. Each new
  ref is read once through `t3.browser/sessions` `getFavicon` when a
  snapshot or upsert delivers it, and cached per origin (`faviconStore.ts`,
  pure and tested) ahead of the provider tier: public origins resolve their
  icon through `@t3tools/shared/favicon`'s public provider; private/loopback
  origins without a capture, non-URLs, and failed loads render a per-origin
  letter glyph. An evicted or unknown ref (`BrowserFaviconNotFound`) or a
  capture that fails to render leaves the provider tier; a failed provider
  origin is cached (per origin, capped at 40 like the native store) so the
  tab strip and the recents list agree. The session tab strip is the
  thread's sessions from the events snapshot — clicking a tab presents that
  session in this panel (the hold is plugin state, no engine op), and the
  loopback folding mirrors the native favicon key, minus the
  environment-hostname fold no contract exposes.
- The panel's own right-panel tab shows the presented page's icon and an
  audio indicator (audible while any session plays unmuted, muted when only
  muted sessions play) through `ViewSession.setTabIndicators`; the host
  renders them, and adds the provider tier itself.
- `t3.browser/sessions` `resize` — the header's device-toolbar
  toggle and the toolbar it reveals (Responsive/preset picker, freeform
  width × height inputs, rotate, close) drive every viewport change through
  `resize` on a serialized per-session queue with the native 15 s commit
  timeout; a failed or timed-out commit reports its named error through
  `t3.ui/notifications` when granted and the inline fault line otherwise,
  and rolls back by never applying — the toolbar renders the session
  snapshot's viewport, never a plugin-side copy, so a restored session comes
  back at its saved viewport. The preset catalog is
  `@t3tools/shared/previewViewport`'s (the Chrome DevTools table the native
  picker uses), and freeform sizes clamp to the same 240–3840 /
  3840×2160-area envelope. In device mode the slot keeps presenting the
  whole content area — the host's engine view lays the W × H frame out
  inside it exactly as for the native panel — while the plugin paints its
  toolbar over the strip the engine reserves and a visible frame plus fit
  percentage from the mirrored layout math. Native's resize rails (left,
  right and bottom edges, both bottom corners, arrow keys on a focused rail)
  sit in the rail gutter the engine reserves; a drag commits as it moves
  with at most one `resize` in flight, and its preview clears once the last
  commit settles.
- `t3.ui/theme` — under the `t3.ui/theme.read` grant: `getTokens` resolves
  the host's effective theme (stored preference, session overlay, or
  external preview — the provider folds them) and `subscribeState` re-reads
  on every transition. Resolved values land on the view root as
  `--t3-browser-*` variables ahead of each style's legacy `var()` chain. An
  installation without the grant — or a host that never connects a theme
  provider — renders the pre-contract appearance unchanged, and a failed
  read or a lost subscription clears the overrides rather than presenting
  an obsolete palette as current.
- `t3.ui/keybindings` (`t3.ui/keybindings` grant; `t3.ui/keybindings.global`
  for the toggle) — `mod+r` (reload), `mod+l` (focus address) and
  `mod+=`/`mod+-`/`mod+0` (zoom in/out/reset) are `surface`-scoped commands
  registered per view and bound through `session.bindCommands`, so the
  host's focused-view arbitration reaches the handler; `mod+shift+j` is an
  installation-scoped `toggle` staged through `registerGlobalCommands` at
  factory time. User and native rules always win — a chord the native
  `preview.*` rules claim never reaches the plugin.
- `t3.ui/panels` + `t3.ui/notifications` (`t3.ui/panels` / `t3.ui/notify`
  grants) — the `toggle` command runs the native open/activate/close cycle
  and toasts through `t3.ui/notifications` when it cannot act (the native
  `preview.toggle` "desktop-only" parity). Transient panel status —
  navigation failures, ended sessions — stays inline like the native
  unreachable view; nothing else toasts.
- `t3.ui/external` (`t3.ui/external.open` grant) — the address row's
  "Open in system browser" hands the current page to the user's own client
  (the OS opener on desktop, a new tab on web). Only absolute `http:`/`https:`
  URLs go out; workspace-file presentations stay in the panel, and a refusal
  or denied grant shows on the fault line.

Chrome row + navigation state stay panel-local (`viewModel.ts`, pure and
tested); the project history client lives in `projectHistory.ts` and the
view's own fallback list in `historyStore.ts`; addresses
normalize with the same `normalizePreviewUrl` the native panel uses
(`@t3tools/shared/preview`).

Package-owned helpers ported from the native panel (`historyStore.ts`,
`runtimeTabId.ts`, `previewAnnotation.ts`, `elementContext.ts`). Project
history is client-local like the native store: another device connected to
the same environment keeps its own list.

```sh
pnpm --filter @t3tools/extension-browser test
pnpm --filter @t3tools/extension-browser build
pnpm --filter @t3tools/extension-browser check
pnpm --filter @t3tools/extension-browser audit
```
