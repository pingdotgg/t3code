# Phase 2 — Reliability, multi-environment, T3 Connect

## Goal

Keep several environments available, read cached state offline, queue text turns safely, recover across lifecycle changes, and reach environments through public T3 Connect (Clerk + DPoP + relay).

Performance benchmarking is **out of scope** until after Phase 3.

## Architecture ownership

| Concern              | Owner                                                            | Notes                                                                              |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Socket + retry       | `OnlineChatRepository` supervisor per environment                | UI never opens sockets or retries                                                  |
| Connectivity wakeup  | `AndroidConnectivity` → supervisor signals                       | Offline aborts session; online wakes                                               |
| Lifecycle resume     | `onBackgrounded` / `onForegrounded`                              | &lt;10s → 3s probe; ≥10s → full reconnect                                          |
| Persistence          | `NativeDatabase` (SQLiteOpenHelper v1)                           | Plan mentioned Room; SQLite is equivalent and lighter for this experimental module |
| Credentials (bearer) | `AndroidCredentialStore`                                         | AES-GCM + Android Keystore; scoped by environment id                               |
| Credentials (cloud)  | Clerk session + in-memory DPoP relay token cache                 | Cloud sign-out does not delete local bearer envs                                   |
| DPoP key             | `AndroidDpopSigner` / Keystore alias `t3_native_cloud_dpop_p256` | Non-exportable P-256                                                               |
| Outbox               | SQLite `outbox` + per-thread single-flight drain                 | Persist before clear; remove only after accept or permanent fail                   |

## Schema (v1)

- **environments** — id, label, http base URL, kind (`Bearer` \| `Relay`), desired, updated_at
- **settings** — key/value (selected environment, app settings JSON)
- **snapshots** — (environment_id, kind, item_id) → schema_version, sequence, payload JSON
  kinds: `shell` / `thread` / `server-config`
- **outbox** — durable pending text turns (message_id PK, ordered by created_at per env+thread)

**Sequence arbitration:** shell/thread writes refuse lower sequence numbers so stale cache cannot overwrite live state. Schema mismatch on load is discarded.

**Scoped cleanup:** deleting an environment cascades snapshots + outbox via FK; drafts and bearer credentials are cleared in the repository `forget` path.

## Outbox state machine

Statuses: `Queued` → `Sending` → removed (accepted) \| `Queued` (transient retry) \| `Failed` (permanent).

- Stable client message/thread ids are assigned before persist.
- Drain is single-flight per `(environmentId, threadId)`.
- Drain requires `Connected` + shell `Synchronized`.
- Transient: transport / IO → backoff via `ConnectionPolicy` delays (3s/4s/8s/16s).
- Permanent: user-visible failure; Edit / Delete / Retry in the pending UI.
- Process death while `Sending` requeues as `Queued` on restore.

## T3 Connect

Public client config (already shipped in T3 web/mobile bundles):

- Clerk publishable key + JWT template `t3-relay`
- Relay base `https://relay.t3.codes`
- Application id `com.t3tools.t3code.native.experimental`
- OAuth redirect `clerk://com.t3tools.t3code.native.experimental.callback` (manifest intent-filters registered)

**External gate:** production Clerk must allowlist that redirect URI. Until then OAuth returns a short actionable error; password sign-in and the full DPoP/relay client path remain wired.

Sign-out clears Clerk session, in-memory relay tokens, and forgets **relay** environments only.

## Connection policy

| Constant      | Value                        |
| ------------- | ---------------------------- |
| Retry delays  | 3s, 4s, 8s, 16s (capped)     |
| Stable lease  | 30s connected resets attempt |
| Probe timeout | 3s                           |
| Long resume   | ≥10s background → reconnect  |

## Scorecard evidence

| Capability                    | Direct bearer | T3 Connect  | Evidence                                                               |
| ----------------------------- | ------------- | ----------- | ---------------------------------------------------------------------- |
| Pair/connect/reconnect        | Yes           | Code path   | `:protocol:test`; S25 `AndroidProtocolIntegrationTest` (shell + probe) |
| Multi-environment supervision | Yes           | Code path   | Per-env supervisors; `NativeDatabaseTest` multi-env + scoped cleanup   |
| Cached offline read           | Yes           | Same cache  | Sequence-safe snapshots; stale lower sequence rejected                 |
| Durable outbox                | Yes           | Same outbox | `OutboxPolicyTest` + `NativeDatabaseTest` order/edit/delete            |
| Thread org / settings         | Yes           | Same UI     | Pin/snooze/settle/archive reverse actions + Settings                   |
| DPoP crypto                   | n/a           | Yes         | `DpopCryptoTest` (JVM) + `AndroidDpopSignerTest` (Keystore)            |
| Performance                   | Deferred      | Deferred    | Explicit Phase 2 non-gate                                              |

**Identity:** email one-time code via `Clerk.auth.signInWithOtp` + `verifyCode` (same strategy official mobile AuthView uses). Password is not the primary path.

**Residual external gate:** production Clerk must allowlist `clerk://com.t3tools.t3code.native.experimental.callback` before Google/OAuth can complete end-to-end. Client redirects and humanized error are implemented; DPoP/relay follow after any successful Clerk session.

### Device / chaos

Run on a disposable server (never `~/.t3/userdata`):

```bash
# unit + assemble
./gradlew :protocol:test :app:testDebugUnitTest :app:assembleDebug

# instrumented (device attached)
./gradlew :app:connectedDebugAndroidTest

# optional protocol E2E on device
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.pairingUrl="$PAIRING_URL"
```

Manual chaos checklist (S25 Ultra):

1. Pair two direct environments; switch UI — both stay supervised.
2. Airplane mode → enqueue/edit/delete pending → online → one accept, no duplicate bootstrap.
3. Force-stop app with pending + cache → cold start renders cache, requeues Sending.
4. Background &lt;10s vs ≥10s — probe vs reconnect.
5. Forget environment — credential, cache, drafts, outbox gone; other envs intact.
6. T3 Connect: sign-in (password or OAuth once allowlisted) → list relay envs → connect → sign-out leaves local bearers.

## Phase 2 boundaries

**In:** multi-env supervisors, SQLite catalog/outbox/cache, lifecycle policy, text-turn outbox UI, thread org/settings, public T3 Connect client.

**Out:** attachments picker/upload, terminal/git/files/review (Phase 3), perf suite (after Phase 3), Play distribution / FCM (Phase 4).
