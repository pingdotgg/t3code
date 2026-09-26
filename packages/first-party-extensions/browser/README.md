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
- `t3.file/presentation.open` routes browser-previewable files
  (`.html`/`.htm`/`.pdf`) to `t3.browser/view`. The view mints a
  `t3.resources/lease` `workspace-file` URL (`t3.workspace/resources` grant),
  resolves it on the document's own origin and opens it in a session; sibling
  assets load under the same token. The token lives 1 h, so the view keeps the
  workspace path — never the minted URL — in history and restore state, and
  Reload re-mints. A client not served from the environment's HTTP origin
  (the desktop `t3code://` renderer, a foreign web origin) gets a named
  state: the SDK does not tell plugins the environment origin.
- `t3.browser/local-servers` (`t3.browser/read-local-servers` grant) fills
  the empty state's "Local servers" section while it is visible. Loopback
  URLs open as-is — unlike the native panel they are not re-mapped to a
  remote environment's host, and the section says so.
- Favicons — the package half of the native favicon row; capture is
  engine-blocked. The native panel's PNG favicons are captured by the
  desktop host (`FaviconCapture.ts`) and delivered over desktop-internal
  IPC to a private store; `t3.browser/sessions` session objects and events
  carry no favicon field and no op returns one, so this package cannot
  capture and does not pretend to. What ships is the fallback tier the
  native tab strip already renders (`faviconStore.ts`, pure and tested):
  public origins resolve their icon through `@t3tools/shared/favicon`'s
  public provider; private/loopback origins, non-URLs, and failed loads
  render a per-origin letter glyph; and a failed origin is cached (per
  origin, capped at 40 like the native store) so the tab strip and the
  recents list agree and the dead origin stops being requested. The
  session tab strip the favicon renders in is the thread's sessions from
  the events snapshot — clicking a tab presents that session in this
  panel (the hold is plugin state, no engine op), and the snapshot's
  loopback folding mirrors the native favicon key, minus the
  environment-hostname fold no contract exposes.
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
  percentage from the mirrored layout math.
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
  for the toggle) — `mod+r` (reload) and `mod+l` (focus address) are
  `surface`-scoped commands registered per view and bound through
  `session.bindCommands`, so the host's focused-view arbitration reaches the
  handler; `mod+shift+j` is an installation-scoped `toggle` staged through
  `registerGlobalCommands` at factory time. User and native rules always win
  — a chord the native `preview.*` rules claim never reaches the plugin.
- `t3.ui/panels` + `t3.ui/notifications` (`t3.ui/panels` / `t3.ui/notify`
  grants) — the `toggle` command runs the native open/activate/close cycle
  and toasts through `t3.ui/notifications` when it cannot act (the native
  `preview.toggle` "desktop-only" parity). Transient panel status —
  navigation failures, ended sessions — stays inline like the native
  unreachable view; nothing else toasts.

Chrome row + navigation state stay panel-local (`viewModel.ts`, pure and
tested); the persisted URL history lives in `historyStore.ts`; addresses
normalize with the same `normalizePreviewUrl` the native panel uses
(`@t3tools/shared/preview`).

Package-owned helpers ported from the native panel (`historyStore.ts`,
`runtimeTabId.ts`, `previewAnnotation.ts`, `elementContext.ts`). One honesty note:
the persisted URL history is **per view record** (per thread), not
per-project like the native `byProjectKey` store. `session.save` cannot
aggregate across threads, so project-shared history is a named deferral
— the stored list is provisional behavior for a
single surface, useful groundwork, not parity with the native store.

```sh
pnpm --filter @t3tools/extension-browser test
pnpm --filter @t3tools/extension-browser build
pnpm --filter @t3tools/extension-browser check
pnpm --filter @t3tools/extension-browser audit
```
