# @t3tools/extension-diff

First-party Diff panel (`t3.diff`) as an installable SDK extension,
with streamed diffs and a turn/checkpoint mode, on `t3.vcs/*` and
`t3.orchestration/*`.

This is a read-oriented panel. It consumes `t3.vcs/read` plus the
`t3.file/open` grant (open-in-editor resolution):

- repository capability gate via `t3.vcs/repository.getCapabilities`
  (detected driver, per-operation support — no fabricated clean state),
- diff previews via `t3.vcs/diff`: unary `getPreview` for the common
  case, `streamPreview` once the broker's 64KiB invoke envelope rejects
  the result — the same envelope rejection is the sticky verdict that
  sends later refreshes of a large diff straight to the stream. Streamed
  payloads are reassembled manifest → ordered chunks → terminal frame
  and rendered only after the sha256 checks pass (per-source
  `diffHash`/byte lengths, then the whole-payload `payloadSha256`);
  unverified bytes never reach the parser,
- per-file hunks parsed with the vendored `@pierre/diffs`
  `parsePatchFiles` (the same pure parser the native panel feeds — its
  React `CodeView` imports react-dom and cannot be bundled into an
  extension), rendered as package-owned rows in collapsible per-file
  sections in either a unified or split (side-by-side) layout — within a
  hunk each deletion run pairs line-by-line with the addition run that
  follows it, the shorter side padded,
- full-file context expansion via `getFileContents` /
  `streamFileContents` (same unary-first policy; per-side sha256) for
  two-sided text changes; binary files are detected from the delivered
  patch's literal markers and named — never rendered as fake text,
- `truncated` previews render honestly at last — the stream transport
  is what makes a `truncated:true` body deliverable at all,
- B-slice chrome: grouped file tree with directory collapse, collapse/
  expand-all, reveal-in-file (select → uncollapse → scroll), copy path,
  open-in-editor via `t3.file/presentation.open` (reports the resolved
  surface — mounting it awaits the unshipped `t3.ui/surfaces` contract),
  base-ref picker over `t3.vcs/refs.list`, ignore-whitespace and
  word-wrap toggles, unified/split layout toggle — the layout persists
  per view through `session.save` (records saved before split shipped
  restore as unified; the plugin cannot read or write the host's global
  `diffLayout` client setting, so the two preferences are separate), and
  wrap stays session-local like native's `wordWrap`,
- freshness via `t3.vcs/status.subscribe`: one refresh per distinct
  local-status fingerprint (never per frame, never polled), bounded
  resubscribe on `closed`, honest "stream ended" fallback to manual
  Refresh,
- a Turns mode over `t3.orchestration/status` (`t3.orchestration/read`
  grant): `subscribeAgents` feeds the checkpoint picker (newest first,
  baseline turn excluded), `getTurnDiff`/`getThreadDiff` deliver
  turn-scoped or whole-thread diffs through the same sha256-verified
  stream collector as large workspace previews. Selection reconciles
  when a revert removes checkpoints, and a stale turn falls back to the
  newest survivor — nothing is fabricated when the projection has no
  checkpoints yet,
- checkpoint revert via `t3.orchestration/control`
  (`t3.orchestration/operate` grant): the button only appears when
  `getCapabilities` advertises `checkpoint.revert`, asks for
  confirmation, and reports pending/accepted/rejected/invoke-failure
  honestly. An accepted receipt means the decider recorded the request;
  it does not claim the filesystem restore finished,
- turn-mode expansion is disabled on purpose: checkpoint commits are
  root commits, so `getFileContents`'s merge-base path cannot expand
  turn sources — the panel says so instead of issuing requests that
  cannot resolve,
- line comments (parity row D9) via `t3.messages/enrichment`
  (`t3.messages/write` grant): a per-row affordance builds a
  contiguous run of diff rows (shift extends), and the form submits
  the native `buildDiffReviewComment` shape through `attachAnnotation`
  into the composer draft — `selection` in old/new file line numbers
  with per-endpoint sides, review-row indices, `rangeLabel`, and the
  quoted hunk capped at the contract's 4096 chars (whole head lines
  kept while they fit, else a character-boundary cut that never splits
  a surrogate; `<review_comment` tags in quoted content are
  neutralized so a quoted line cannot forge markup).
  `listAnnotations` surfaces earlier unsent comments and
  `removeAnnotation` retracts them. The selection and the open draft
  are pinned to the delivered source hash + file + loaded expansion:
  a refresh or expansion that reshapes the rows retires the pin (a
  drift under an open form turns it stale instead of letting submit
  ship anchors captured against different lines), while a
  byte-identical redelivery legitimately keeps it,
- `t3.ui/*` adoption: theme values resolve through
  `t3.ui/theme.getTokens` + `subscribeState` (stored preference,
  session overlay, and external previews all re-resolve the panel's
  `var(--x, token)` fallbacks; a missing grant keeps the static
  values), the `mod+d` toggle stages through
  `ClientHost.registerGlobalCommands` and the mounted view binds via
  `session.bindCommands` so host arbitration (focused view →
  thread-matched binding → installation handler → cold activation)
  owns precedence, and the toggle itself runs through
  `t3.ui/panels` (`listSurfaces` → open/activate/close, matching the
  native `diff.toggle`). Panel access gates availability: the view
  runs a grant-enforced `listSurfaces` read before registering
  (denied or unreachable panels access means the command is never
  offered), and a dispatch that finds the capability denied or
  revoked withdraws the command set so the palette stops offering
  it. `t3.ui/notify` is used only to report
  command-dispatch failures and access loss — a rejected toggle has
  no in-panel affordance, so an error toast is the honest channel;
  status rows stay inline, matching the native panel.

Deferred slices: Pierre renderer features (react-dom is bundler-banned)
— syntax highlighting, virtualization, sticky headers;
repo-root→workspace path remapping for open (no public repo-root
contract).

```sh
pnpm --filter @t3tools/extension-diff test
pnpm --filter @t3tools/extension-diff build
pnpm --filter @t3tools/extension-diff check
pnpm --filter @t3tools/extension-diff audit
```
