# @t3tools/extension-agents — Agents panel

The `t3.agents` side-panel surface, live over the public orchestration
contracts: roster, status, metrics, pending requests, checkpoints, and
control operations, plus checked-in `t3.json` project scripts through a real
terminal.

- `t3.agents/view` — `side-panel`, `thread` scope, `web`/`desktop` clients,
  null-only restore state. Same surface registration as the native manifest.
- `t3.orchestration/status@^1.0.0` — under the `t3.orchestration/read` grant:
  `subscribeAgents` streams the server-folded projection (agents, pending
  approvals and user inputs, checkpoints, session, turn, receipts) as bounded
  snapshot/update frames; `getCapabilities` drives per-operation gating and
  is re-fetched whenever the folded inputs it derives from change (workflow
  script paths, bound provider instance, session), so operations that become
  available mid-session light up without reopening the panel. Provider changes
  made from another client produce no thread-scoped feed event, so the session
  controls carry an explicit Refresh button as the recovery path for those;
  `getWorkflowScript` and the `getTurnDiff`/`getThreadDiff` chunked streams
  serve the script viewer and checkpoint diffs. Diff frames are reassembled
  and verified end-to-end (chunk order, byte lengths, per-source and
  whole-payload sha256) before a byte renders — the same verification the
  diff panel performs. A server `closed` frame (queue overflow) resubscribes
  with a bounded retry; hiding the panel abandons the stream.
- `t3.orchestration/control@^1.0.0` — under the `t3.orchestration/operate`
  grant: `turn.start`, `turn.interrupt`, `session.stop`, `approval.respond`,
  `userInput.respond`/`dismiss`, `thread.settle`/`unsettle`, and
  `checkpoint.revert` (behind an inline confirm). Every command carries a
  fresh `commandId` and the stream's `expectedEpoch`; accepted/rejected
  receipts render next to the control. Operations the provider does not
  advertise render as named "unsupported" rows — never fake buttons.
- `t3.workspace/files@^1.0.0` `readText` — reads the checked-in `t3.json`
  under the `t3.workspace/read-text` grant and lists its `scripts[]` entries.
  Settings-owned project scripts (machine defaults, per-project overrides)
  have no public read contract; the panel says so instead of pretending.
- `t3.terminal/control@^1.0.0` `attach`/`write` — under the
  `t3.terminal/operate` grant, Run claims the script's dedicated
  `t3-agents-<name>` terminal (spawning on first use, respawning when
  stopped). `attach` is not create-exclusive, so every returned session is
  verified (right id, alive, no running subprocess) before write; busy or
  foreign sessions overflow to nonce-keyed ids (`t3-agents-<name>-<nonce>-N`),
  fresh per panel mount so recreated panels and concurrent clients never
  re-pick a live terminal. If no candidate is claimable the run fails by name
  rather than writing into someone's foreground process. The write is the
  native `command + "\r"` with the native script env (`T3CODE_PROJECT_ROOT`,
  `T3CODE_WORKTREE_PATH`). Output appears in the terminal surface.
- `t3.ui/theme@^1.0.0` — under the `t3.ui/theme.read` grant: `getTokens`
  resolves the host's effective theme (stored preference, session overlay,
  or external preview — the provider folds them) and `subscribeState`
  re-reads on every transition. Resolved values land on the view root as
  `--t3-agents-*` variables ahead of each style's legacy `var()` chain, so an
  installation without the grant — or a host that never connects a theme
  provider — renders the pre-contract appearance unchanged. The overrides are
  cleared, never retained, when a read fails or the state stream is lost:
  the contract can no longer vouch for the painted theme, so the legacy chain
  takes back over. The panel keeps
  inline `<output>` receipts instead of `t3.ui/notifications` toasts (the
  native Agents surface is read-only and never toasts), and registers no
  `t3.ui/keybindings` commands (the surface has no shortcuts natively; the
  host-owned `thread.settle` command already covers the thread level).

The roster renders the native model exactly: workflow coordinators group
their members into phases and never double-count work or tokens; statuses
collapse to Working / Idle · resumable / Completed / Failed / Stopped; the
activity line keeps the native precedence (live rows lead with progress,
settled rows with the outcome).

Still deferred — named in the panel, not faked: workflow launch (no native
binding exists), agent logs and session deep links (net-new design, plus
navigation contracts), agent session scan/import (needs a narrow public scan
contract), and the mobile Agents surface.
Thread settled state is not projected by the status contract, so Settle and
Unsettle are both offered when the provider supports them and the receipt
reports the outcome.

Proof level: contract-path only. The installed-path checks below ran from
development scripts kept outside the repo:

- `install-proof.mjs` → `install-proof.json` installs this exact packed
  bundle through the production `createExtensionRuntime` against the real
  event engine, projections, and SQLite command receipts — per-name grant
  denial (`t3.orchestration/read`, `t3.orchestration/operate`), read-only
  grants cannot operate, the folded `subscribeAgents` snapshot plus a live
  update after a real engine dispatch, `thread.settle`/`thread.unsettle`
  through the real decider (correlated, persisted, idempotent receipts),
  named `OrchestrationUnsupported` receipts for provider-dependent ops, and
  end-to-end verified diff reassembly.
- `terminal-proof.mjs` → `terminal-proof.json` runs a disposable production
  server over HTTP and exercises `readText` on `t3.json`, per-name grant
  denial over the wire, a real PTY `attach`/`write`, and read-back of the
  side effect through this package's own workspace grant.

The installed-view host path — menu/right-panel navigation mounting this
surface — is not yet exercised in a real client, the same standing caveat as every
first-party panel.

- `pnpm run build` / `check` — pack and validate `.t3-extension/`
- `pnpm test` — view-model unit tests (script parsing, terminal-id
  allocation, run state machine, roster derivation, stream fold, control
  gating, verified diff reassembly)
- `pnpm run audit` — private-import audit
