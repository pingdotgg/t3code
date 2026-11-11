# Server updates

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime
selected by systemd, launchd, or Task Scheduler. It is the only runtime writer of durable service
state. Server children request updates over inherited IPC; they never rewrite
their service definition or select their own replacement. Local service commands
may replace the launcher and state, optionally deferring the restart. Foreground
CLI processes do not self-update.

Both writers serialize state and unit writes through
[file leases](../../apps/server/src/cloud/serviceSelectionLock.ts). The installer
takes the state lease before the unit lease; the launcher never holds both, so a
unit failure cannot block a durable commit. Manager stop/start commands run outside
both leases, since stopping a launcher that waits on a lease would deadlock. A
running launcher refuses further updates once a local command changes its selection.
A protocol-3 launcher takes no lease, so a local command can still race its updates.

Exact-version installs keep restarts independent of npm cache eviction or a moving
release tag. Installation and preflight happen in staging before publishing an
immutable runtime. Preflight checks the launcher protocol because a target that
needs new rollback guarantees cannot safely run under an older launcher. A remote
update replaces only the child, so upgrading the launcher requires a local service
update with a restart. Every installed launcher is therefore one protocol behind
after a bump, and a target that refuses the previous protocol stops remote updates
for every existing service. Refuse it only when the child cannot work under it.
Protocol 4 changed the launcher alone, so its runtime still runs under protocol 3.
The server names its launcher's protocol to preflight, not its own, since the two differ
after the first such update.

After a commit or rollback the launcher points the unit at the selected runtime and
reloads the manager, so the next service start runs that version's launcher; the
protocol check is what makes that safe. Each start after a finished update retries this, because
a previous reload may have failed, and leaves a unit naming a newer runtime or another
T3 home alone. A protocol-3 launcher does none of this: its unit keeps naming the
runtime that installed it. Until a deferred local upgrade restarts, systemd (before
daemon-reload) and launchd (before bootstrap) can respawn the old launcher, which
rejects the state the new installer wrote.

Task Scheduler tracks only the console host it started, not the launcher. `schtasks /End`
kills that host and nothing else; the launcher takes its closed console as SIGTERM. The task
reads as stopped at once, and `/Run` then starts a second launcher beside the first, so a
Windows launcher holds a lock file for as long as it runs. A replacement waits for that lock,
and the CLI treats its release as the stop having finished.

Task Scheduler also runs its own copy of the task, and registering one enables it. So every
write of the task file registers it, including an install that defers its restart. The CLI
disables the task under the unit lease, and a registration under that lease keeps a disabled
task disabled, so the repeating trigger cannot restart a service the CLI is holding stopped.

## Commit boundary

The launcher durably records the pending update before acknowledging it, then
stops the old child and starts the target as a trial. Service-state writes use
same-directory replacement with file and directory fsync. Invalid state stops
startup rather than guessing which runtime to boot.

The trial must finish migrations, acquire dependencies, bind HTTP, and park every
long-running root at the activation gate before reporting `prepared`. The launcher
then commits the target version durably and replies `committed`. Only then may the
child release its gates, accept commands, and publish ready. Keep fallible startup
acquisitions before this boundary. A listener alone does not prove the runtime is
ready to commit.

A failed or timed-out trial returns to the old version. After commit, the target
is authoritative and the service manager's ordinary restart policy applies.

The prepared deadline is long because migrations can scale with the database
and block the trial's main thread, so it cannot report progress. A missed
deadline restores the snapshot, and the retry pays the same cost again. A
crashed trial is caught when it exits; the deadline bounds only a stuck one.
Client update waits must outlast the deadline, or a slow update shows as failed.

## Database rollback

Before stopping the old child, the launcher refuses an update whose snapshot will
not fit on disk, so a full disk does not cause an outage. After the old child
exits, the launcher snapshots SQLite's main file, WAL, and shared-memory file. This makes trial migrations reversible without down
migrations. The snapshot is made once per update and survives launcher restarts;
replacing it during a retry could capture changes from the failed trial.

Rollback stops the trial before restoring. A durable restore marker makes an
interrupted restore finish before either version boots. Keep the snapshot until
commit, or until both restoration and the terminal rollback state are durable.
Attachments and other files outside SQLite are outside this rollback boundary.

## Client acknowledgement

An accepted update is still pending. Clients correlate the launcher's update ID
with the ready event after reconnecting, then check the outcome and target version.
A reconnect alone cannot distinguish successful replacement from rollback. Older
servers without an update ID retain version-only correlation.

Desktop updates have a separate two-phase handoff because installing the app stops
its bundled backend. Preparation returns a token while the connection is alive;
the client commits that token only after receiving it. Otherwise backend shutdown
could lose the only successful RPC result. The client must then observe the
prepared version after reconnecting. If installation fails, desktop restarts the
stopped backends and replays the failure for the same token.

## Recovering interrupted threads

Restart continuation is an environment-owned preference, on by default. A
`settings.json` that fails to decode turns it off, since the file may hold an
opt-out. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A settled run qualifies only when the restart cancels work the agent waits on
(a subagent, a background task, or a shell or monitor the agent marked with
`t3_background_wait`) and its session was live, so stale records from an older crash
never wake it. Its continuation prompt is the note of what will not report back. An
unmarked shell or monitor does not wake a settled run: most are dev servers and their
watchdogs that nobody waits on, so that note waits for the next user message.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness or the launcher's commit boundary. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, provider selection, newer user work, a stop the user requested,
and maintenance turns such as `/compact` before dispatching. Intent and delivery both
refuse a thread that is archived, settled, or still snoozed, a cut turn whose provider
turn already ended, and a run waiting on the user: an approval, question, or secret that was pending,
or that recovery closed on the cut turn. Message-capable questions stay answerable, so
they do not block. Delivery also stops after three consecutive continuations in one
`restartContinuationOfRunId` chain, so a turn that crashes the server cannot loop. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
