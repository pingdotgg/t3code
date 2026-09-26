# @t3tools/extension-terminal — interactive terminal panel

Interactive terminal plugin driven entirely by public contracts:

- `t3.terminal/sessions@^1.1.0` — `inspect` plus the `list` metadata stream
  (snapshot → upsert/remove) that drives the session tabs
- `t3.terminal/control@^1.0.0` — open (client-chosen id via
  `nextTerminalId`), attach (`restartIfNotRunning`), write, resize, clear,
  restart, close; all gated behind the distinct `t3.terminal/operate` grant
- `t3.terminal/output-events` `subscribe` — snapshot → chunked output →
  reset/exit/closed lifecycle frames
- `t3.ui/theme@^1.0.0` (`t3.ui/theme.read` grant) — `getTokens` resolves the
  host's effective theme (stored preference, session overlay, or painted
  preview, folded by the provider) and `subscribeState` re-reads it on every
  transition; `subscribeTerminalAppearance` carries the real terminal colors
  and font. Both republish as `--t3-terminal-*` custom properties ahead of
  the legacy `var()` fallbacks; a denied read or a dead stream clears the
  overrides so nothing contract-derived outlives its feed. On the VT pane
  the same properties feed `terminalThemeFromApp` → `surface.setTheme`, so
  the canvas and the chrome share one theme pipeline.
- `t3.ui/keybindings@^1.1.0` — per-view `toggle`/`new`/`close`/`split`/
  `splitVertical` commands (default keys mirror the native
  `mod+j`/`mod+n`/`mod+w`/`mod+d`/`mod+shift+d` chords; the host's
  user/native precedence decides who claims them), plus a staged
  installation-scoped `toggle` with a bottom-dock `activation` fallback for
  cold open (`t3.ui/keybindings.global` + `t3.ui/panels` grants). All actions
  are bound per view through `ViewSession.bindCommands` and stay panel-local.
  The focused chords resolve through the client-local
  `host.keybindings.resolveTerminalFocusKey` (see below).
- `t3.ui/panels@^1.0.0` — the dispatched `toggle` closes the hosting surface
  via `closeSurface`; failures surface on the panel status row.

All seven APIs are mandatory requirements — invocation authority only exists
for declared contracts, so a host without the `t3.ui/*` providers resolves
this package `missing-api` rather than mounting a half-contracted panel. The
degraded paths above cover denied grants, failing calls, and dead streams on
a capable host.

`t3.ui/notifications` is deliberately not adopted: the native terminal only
toasts on link-preview failure, and this panel has no link-activation path —
its inline status rows match native usage. The Ghostty-level editing
intercepts (clear, word-nav, delete) are implemented locally on the VT
surface via `handleBeforeKey`; what remains absent is adopting them as
configurable commands through `t3.ui/keybindings`.

## Split groups and focus claim

The panel ports the native drawer's group model: every session belongs to a
group of at most 4 terminals, and the active group's members render
side-by-side — columns for `horizontal`, rows for `vertical` — each with its
own VT attachment and PTY stream. `terminal.split` (`mod+d`) inserts a fresh
session after the focused pane and `terminal.splitVertical` (`mod+shift+d`)
does the same stacked; at 4 panes the split controls disable with the
native "(max 4 per group)" label and the chord is refused before any PTY
spawns. `terminal.new` (`mod+n`) opens a session in its own group;
`terminal.close` (`mod+w`) closes the focused pane and the group collapses,
empty groups dropping away. Clicking a pane focuses it; clicking a session
or group header in the sidebar activates that terminal (and its group).
Group membership, direction, and the active group persist in the view's
restore state; pre-split records restore as one singleton group per
session. Tab order persists too: unlike the native reconcile, a session list
whose membership changed (sessions opened or closed elsewhere) keeps the
surviving tabs in their saved order and appends new sessions. Panes outside the visible group stay mounted but hold no output
stream — the host caps each installation at 8 concurrent plugin streams,
and the sessions/theme feeds already take 3, so attaching every tracked
session at once would starve the sessions stream itself. Hidden panes
re-attach and resume their retained history when their group is shown.

The surface declares `claimsTerminalFocus`, so the host tags the frame
`data-terminal-owner="extension"` and leaves the four focused terminal
chords untouched instead of routing them to a native terminal. Owning the
claim means owning the keymap. The view captures keys at its root
(`onKeyDownCapture`, ahead of the VT encoder) and asks
`host.keybindings.resolveTerminalFocusKey` what the host's dispatcher
resolved. That is the dispatcher's own resolver over the live keymap, so
user remaps (including `terminalFocus`-guarded ones and chords with no
default) apply from the first press. The four `terminal.*` commands
dispatch through the same actions the registered `t3.ui/keybindings`
commands drive, and every other key is left for the shell. A host without
the resolver gets the shipped default chords only. `mod+j` stays the
host's: focused in the extension dock it hides that dock, as it hides the
native drawer from inside it; anywhere else it drives the native drawer.
The `<pre>` fallback for asset-less hosts stays single-pane — the group model
still applies (sidebar membership and activation), it just does not render
side-by-side.

## Rendering: real Ghostty VT (format 4)

The panel renders through `@t3tools/ghostty-terminal`, the same libghostty-vt
adapter the native terminal drawer uses, with its WASM closure packaged as
digest-verified extension assets:

- `assets/ghostty-vt.wasm` — terminal core, parser, render state
- `assets/ghostty-write-pty.wasm` — PTY-write callback trampoline
- `assets/SymbolsNerdFontMono-Regular.woff2` — symbol fallback font

The bytes live once, in the package's `assets/`. `stageGhosttyAssets.mjs`
copies them into this package's gitignored `assets/` on install and before
every `build`, because `t3-extension build` packs only files inside the
source directory. The host delivers verified bytes via `host.readAsset`;
`loadGhosttyRuntime` instantiates one shared runtime and each surface allocates its own terminal
handle. The runtime allows 4 concurrent asset reads per installation, so
every mounted placement shares one sequential load (`assetLoader.ts`) and a
read refused at that cap backs off and retries. A host without asset
support still works: the panel falls back to a bounded `<pre>` text view
that drops escape sequences and honors the same `--t3-terminal-*` contract
variables and `::selection` styling.

The `.t3-extension/` bundle inlines SDK and shared code, and
`t3-extension check` only compares it with its own receipt, so check cannot
see a stale bundle; run `vp run build` here after SDK or source changes.

## Attach semantics (honest degradation)

`vtAttachment.ts` mirrors the native attach reducer: snapshot frames reset
the parser and re-base it, chunked output reassembles before reaching the
parser, and `identity-changed`/bounded `overflow` closes resubscribe. A
**truncated** attach tail loses parser state that lived before the retained
8 KiB — the tab shows "earlier history was truncated" and does not claim
interactive parity until a full snapshot or reset re-bases the parser.

A host **history clear** only drops retained output — it never reaches the
process or renegotiates modes. A live surface therefore gets a
mode-preserving erase (ED 2 + ED 3, `clearScreen`), not an RIS reset, so
application-cursor/bracketed-paste/kitty state survives and input keeps
encoding the way the process expects. If the clear lands before the renderer
attaches, the mode-establishing bytes are gone from the replay base — the
tab stays degraded until a full snapshot re-proves parser state. Clearing
history is never treated as proof of recovered mode state.

A **renderer start failure** is sticky: output and snapshot frames keep
feeding the bounded replay buffer for a later remount, but they never
re-flag the pane "live" while no renderer exists — only an `attach` whose
replay completes clears the error (a throwing replay drops the
half-written sink and keeps the failure).

**Remount replay** splits around unanswered runs: bytes a live sink
already parsed were answered once and replay with the PTY writer detached
(`beginReplay`/`endReplay`), so DA/DSR/DECRQSS queries inside them are
not re-sent. Live output buffered while detached was never parsed — each
contiguous run of it replays _with_ the writer attached so its queries
get exactly one reply, at the cursor position those bytes actually
produce. Provenance is positional, never textual: the host reports each
snapshot's `contentsUnitStart` — the absolute UTF-16 offset of the tail
inside the retained-history window (`streamEpoch` + `clearGeneration`)
— and every run's absolute position is known from the stream's own
recorded start, so line eviction, byte eviction and tail truncation are
the same arithmetic. A run whose absolute position precedes the new
contents is provably evicted — dropped, never migrated onto a later
identical query — and a surviving run is still verified byte-for-byte at
its computed position. A same-epoch `clearGeneration` bump is a missed
clear: the old window's claims die with it. Runs are fenced to their
stream epoch in both directions: a pending reply belongs to the process
that asked and is discarded at incarnation end
(identity-changed/close/exit), and replay holds claims unreleased while
the epoch is unproven — a mount inside the beginStream→snapshot gap
answers nothing until a same-epoch snapshot re-proves the claim. Queries
inside snapshot/history bytes are treated as already-rendered history
and stay suppressed (the documented drop: only live output the
attachment saw go undelivered earns a reply).

The coordinates are the raw delivered stream end to end: the host
retains exactly the bytes the process emitted — stripped query classes
and incomplete trailing controls included — so `contentsUnitStart`,
`retainedByteLength`, pending-reply positions and live `output` chunks
all count the same units and sanitization can never shift them. The
sanitizer still runs, but only at display/replay boundaries (the native
attach snapshot, `readOutput`), never between delivery and retention.

Parser fidelity likewise needs host evidence, not observation history:
the replay base is faithful only when a snapshot reports
`clearGeneration === 0`, `contentsUnitStart === 0` and `truncated ===
false` — the retained window provably covers every byte since the
process started. An attachment whose first snapshot arrives after a
clear (`clearGeneration > 0`), or after any retention eviction, mounts
degraded instead of claiming modes it cannot reconstruct.

Sequencing uses two fences: the broker's per-subscription frame sequence and
the session's native `eventSequence` watermark, which must strictly increase
across snapshot boundary, output groups, resets, and exits. An output chunk
that does not continue an open group fails the stream rather than silently
swapping groups.

## Input: serialized-byte transport

`inputQueue.ts` batches input against the serialized `write` invocation —
`{terminalId, data}` as UTF-8 JSON — with a 48 KiB per-write budget and a
256 KiB pending cap, splitting surrogate-safe. On a write whose outcome is
unknown (transport failure, timeout, post-send server error) the queue
halts: the failed batch and everything behind it are discarded and never
resent. The tab shows an "input stopped" banner and only an explicit resume
(or restart) reopens input.

The unknown-outcome failure mode is only partially solved: a client-side
timeout cannot prove whether an in-flight write reached the PTY, and there are
no host operation IDs, cancellation, or ordering fences to disambiguate it —
hence halt + discard + explicit resume rather than replay. Host-side op-id
fencing remains unsolved.

## Known limitations

- **Dock sizing:** dock geometry is host-owned; the plugin only sizes
  its own terminal content.
- **Remote pixels/frames:** out of scope; rendering is local WASM only.

## Development

- `pnpm run build` / `check` — pack and validate `.t3-extension/` (format 4)
- `pnpm test` — view-model, VT conformance (real WASM), input-transport,
  attach/recovery, PTY-fixture, and surface-level byte-transport oracle
  suites
- `pnpm run audit` — private-import audit
