# Server updates

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime
selected by systemd or launchd. It is the only runtime writer of durable service
state. Server children request updates over inherited IPC; they never rewrite
their service definition or select their own replacement. Local service commands
may replace the launcher and state while the service is stopped. Foreground CLI
processes do not self-update.

Exact-version installs keep restarts independent of npm cache eviction or a moving
release tag. Installation and preflight happen in staging before publishing an
immutable runtime. Preflight checks the launcher protocol because a target that
needs new rollback guarantees cannot safely run under an older launcher. Upgrading
that launcher requires a local service update.

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

## Database rollback

After the old child exits, the launcher snapshots SQLite's main file, WAL, and
shared-memory file. This makes trial migrations reversible without down
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

Resuming interrupted turns is an environment-owned preference, off by default. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A finished run qualifies only when the restart cancelled its background work;
its continuation tells the provider what will not report back. That case needs no
preference: the agent ended its turn waiting on that work, and the provider would have
woken it when the work ended. Without the wake the thread sits idle until someone
sends a message.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness or the launcher's commit boundary. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference (for a resumed turn), archive and settled state, newer user
work, a stop the user requested of the current attempt, and maintenance turns such as
`/compact` before dispatching. Stable command and message IDs prevent duplicate
submissions after an outbox retry. Codex resumes without adding provider prompt text
unless the turn lost background work; other adapters receive the continuation message
through their normal turn path.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
