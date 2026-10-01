# @t3tools/extension-agents — Agents panel

The `t3.agents` side-panel surface, live over the public orchestration
contracts: roster, status, metrics, pending requests, checkpoints, and
control operations, plus checked-in `t3.json` project scripts through a real
terminal.

- `t3.agents/view` — `side-panel`, `thread` scope, `web`/`desktop` clients,
  null-only restore state. Same surface registration as the native manifest.
- `t3.orchestration/status@^1.1.0` — under the `t3.orchestration/read` grant:
  `subscribeAgents` streams the server-folded projection (agents, pending
  approvals and user inputs, checkpoints, session, turn, receipts) as bounded
  snapshot/update frames; `getCapabilities` drives per-operation gating and
  is re-fetched whenever the folded inputs it derives from change (workflow
  script paths, bound provider instance, session), so operations that become
  available mid-session light up without reopening the panel. Provider changes
  made from another client produce no thread-scoped feed event, so the session
  controls carry an explicit Refresh button as the recovery path for those;
  `readWorkflowScript` and the `getTurnDiff`/`getThreadDiff` chunked streams
  serve the script viewer and checkpoint diffs. Scripts use native's 256 KiB
  read limit, with chunk-order/count and SHA-256 verification. The Script
  toggle and Close hide the view without refetching successful reads; reopening
  a failed read retries it, matching native.
  Diff frames are reassembled
  and verified end-to-end (chunk order, byte lengths, per-source and
  whole-payload sha256) before a byte renders — the same verification the
  diff panel performs. A server `closed` frame (queue overflow) resubscribes
  with a bounded retry. The stream lives as long as the view so the tab badge
  stays current in the background; a hidden panel folds frames without
  re-rendering and only republishes the badge.
- `t3.orchestration/control@^1.1.0` — under the `t3.orchestration/operate`
  grant: `turn.start`, `turn.interrupt`, `session.stop`, `approval.respond`,
  `userInput.respond`/`dismiss`, `thread.settle`/`unsettle`, and
  `checkpoint.revert` (behind an inline confirm). Every command carries a
  fresh `commandId` and the stream's `expectedEpoch`; accepted/rejected
  receipts render next to the control. Operations the provider does not
  advertise render as named "unsupported" rows — never fake buttons.
  `workflow.launch` (1.1.0) additionally needs the
  `t3.orchestration/launch-workflow` grant: Launch takes a workflow name,
  shows an inline confirm stating the effect, and renders the launch id with
  its accepted/rejected receipt. The host turns it into a turn asking the
  agent to run that saved workflow — Claude threads only; other providers
  show the named unsupported row. The host does not look the name up: the
  agent resolves it. Launch keeps the thread's current mode, so a plan-mode
  thread may answer with a plan instead of running the workflow, and an
  accepted receipt acknowledges the request, not a started workflow.
- `t3.orchestration/logs@^1.0.0` — under its own `t3.orchestration/read-logs`
  grant (roster read never implies it): agent rows whose roster entry carries
  an output handle get an Output toggle that reads the run's bounded tail
  with `readTail` (≤ 8 KiB, last 200 lines; a cut tail leads with an
  "earlier output omitted (source is M bytes)" marker). While open it re-reads
  only when the roster stream reports the run changed — no polling. Missing
  grants, out-of-scope handles and vanished files render the named failure.
  Only Claude runs carry output handles today.
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
- `t3.ui/navigation@^1.0.0` — under the `t3.ui/navigation.open` grant: when
  the current turn implements a plan from another thread, "Open agents there"
  asks the host to route to that thread with this view open. The host only
  routes to a live thread in the view's own project; `unknown-thread`,
  `out-of-scope`, and a missing grant render by name inline.
- `t3.ui/navigation@^1.0.0` `openAgentSession` — under its own
  `t3.ui/navigation.open-session` grant: a roster row that carries a provider
  session handle (today, Claude workflow runs) offers "Open session". The pack
  sends only the agent id; the host looks the session URL up on this thread's
  own roster and hands it to the OS opener. `unknown-agent`, `no-session`,
  `opener-refused` (including a popup the browser blocked), and a missing
  grant render by name inline. There is no transcript navigation (see agent
  logs below).
- Tab badge (`ViewSession.setTabIndicators`, no grant) — the host draws a
  running count (running + waiting agents, the native toggle badge's count)
  on this panel's tab, or an unread count for work that finished while the
  panel was hidden. Showing the panel marks it seen.

The roster renders the native model exactly: workflow coordinators group
their members into phases and never double-count work or tokens; statuses
collapse to Working / Idle · resumable / Completed / Failed / Stopped; the
activity line keeps the native precedence (live rows lead with progress,
settled rows with the outcome).

Import sessions lists the Claude and Codex sessions that ran in this
project (`t3.agents/sessions`, `t3.agents/scan-sessions` grant) and imports
one at a time as a new thread after a Confirm step
(`t3.agents/import-sessions` grant). The host re-discovers the session inside
the project on every import; a duplicate, another project's session, or a
missing grant is named in the row's receipt line. A scan returns at most 50
discovered sessions and stops after 10 seconds; a scan cut short either way
is marked incomplete in the panel, and Rescan retries it.

Still deferred — named in the panel, not faked: agent output file access
(the bounded tail is served by t3.orchestration/logs; the file itself is
net-new design) and the mobile Agents surface. The header live-agent badge
and spawn CTA rows stay host chat UI; with this pack installed (enabled and
granted the thread's project) they open this view instead of the built-in
Agents panel. The right panel toggle under the badge still restores whichever
panel was last shown.
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
