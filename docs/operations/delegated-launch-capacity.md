# Delegated launch capacity

T3 checks delegated launches immediately before opening a provider session. A
missing, stale, incomplete or unsupported usage probe waits for capacity. Waiting
is persisted with the task; cancellation still works, and the durable outbox
probes again at most once per minute per waiting launch. It does not reserve
external quota. A first-request quota refusal returns to admission only before
content, a tool call, a plan or an input request has been observed.

`delegatedLaunchRoutes` in server settings declares ordered, opt-in alternatives
for an exact provider instance and model. The default is an empty list. Configure
only existing subscription instances you authorize for the task. Project provider
enablement and the original runtime mode still apply. Supported model options
are retained; an explicit fallback's options take precedence. No route purchases
capacity or adds credentials.

The [ready-to-apply settings fragment](examples/delegated-launch-routes.json) expresses
Sol → Opus → Astra, Opus → Astra, Copilot Claude → matching native Claude,
native Sonnet/Haiku → Sol, and Kimi/Gemini → Sol. Codex tries the same exact
model on another configured provider first. Sol is always `gpt-6.1-sol`. The
fragment covers the enabled `codex`, `claudeAgent`, `copilot_native_scale`,
`kimi_api` and `antigravity` catalog, including Claude 5.5, both global Kimi
slugs and all three Gemini 3.8 Flash variants. Apply only its
`delegatedLaunchRoutes` field through server settings. It is never loaded
automatically and does not enable providers or change credentials.

Account identity, credential fingerprints and credential-store bindings are
used to skip aliases of a blocked domain, including Sol → Astra on the same
Codex account. Different instance IDs alone do not establish different accounts.
A race-blocked domain is reconsidered after one minute with another fresh probe.
Model-specific exhausted windows block that model's quota across aliases;
unverified evidence does not establish an account-wide exhausted bucket.

Native Claude, Cursor, Grok and local OpenCode Go/Kimi collectors
provide usage evidence. Unknown model-specific quotas (including Codex Spark)
wait rather than treating unrelated bars as proof of capacity. Kimi uses the
read-only `GET /coding/v1/usages` endpoint on `api.kimi.com` for
`kimi-for-coding/*`, and on `api.kimi.ai` for `kimi-code-plan-global/*`.
The global host is the models.dev provider's canonical API; Kimi CLI's usage
reader appends `/usages` to the selected platform API. The collector requires
the matching inline OpenCode auth entry or an explicit inline provider API-key
option. It never substitutes the regional account's key.
OAuth, noncanonical API overrides, credentials loaded only inside an opaque
launcher, and unpinned OpenCode 2 database selection remain unsupported.
External OpenCode servers are unsupported because
local credentials cannot establish the runtime's account.

Direct Codex admission requires runtime `config/read`, ChatGPT `account/read`,
and backend-bound `account/rateLimits/read` evidence. The backend account ID
travels as an opaque quota identity. Verified exhaustion, including an explicit
ordinary-usage denial below 100% on the usage bars, blocks that account across
model aliases without changing the reported percentages. Before generation the dispatch app-server
rechecks that identity, fresh usage and the native thread's provider. Custom
providers, overrides of the built-in OpenAI provider, external API endpoints,
missing backend account IDs and changed accounts remain unverified. A caller's
`pinned` assertion cannot authorize a start. Managed token-sharing instances do
not expose this binding yet and remain unverified.

Native Claude admission uses a fresh read-only SDK capabilities/usage request,
independent of the ordinary five-minute cache. Its dispatch query rechecks
first-party account, organization, subscription and auth-source identity plus
fresh usage before accepting the prompt. API-key and custom-endpoint overrides
remain unverified. These controls do not atomically reserve quota or lock out an
external credential change between verification and generation. A structured
launch refusal still returns to fallback/waiting; no live account-swap or quota
race guarantee is claimed from the unit tests.
Unknown/account-wide first-request refusals block the account across aliases;
only a typed model window observed at admission permits a narrower block.

## Bound `codex-t3` pool launches

A Codex instance whose launcher speaks the `codex-t3` pool protocol can opt in
with `"delegatedLaunchControl": "codex-t3-pool-v2"` in its provider instance
config. The field names a protocol, not a health claim. Without it, a custom
provider stays unverified. With it, T3 still asks the configured `binaryPath`
for `pool-control` capabilities on every prepare. These must be exactly
version 1: all seven control operations, `app-server-stdio`, an `https` origin,
no WebSocket transport and zero native retries. The instance's `launchArgs`
must also be empty. Anything else is unverified.

Admission calls `prepare` with the accounts already proven exhausted for this
launch. A ready result is used only if it is at most 30 seconds old, matches
the request's model and session, names no blocked account and has every
window below 100%. The run persists the exact nonsecret request and result as
`delegatedLaunch.binding`. Request and session IDs are hashes of the run,
launch generation, instance and model. A duplicate delivery or a restart at
the same generation therefore repeats the same logical prepare, and the
proxy answers it idempotently. A new generation or blocked set is a new
request. A bound launch always gets a new provider session. It spawns
`<binaryPath> pool-launch '<json>'`, and the wrapper replays the prepare
under its own credential before it execs `app-server`. No key or helper output
reaches T3's argv, events or state.

Before the first turn, T3 checks four things: the session's lease must be the
run's, the proxy `state` must be pending, inactive, with zero attempts and no
refusal, and the native thread's provider must be `cliproxy_bound`. Any
failure before useful work reads the authenticated `state`:

| `state`                                | Effect                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `usage_limit` with account domains     | Blocks those accounts for every model                                        |
| `throttled` / `model_capacity`         | Skips this instance+model for one minute (`capacityWait.reason` `throttled`) |
| Unknown actual quota/identity evidence | Blocks the account; it is never treated as independent                       |
| Lease `released` / `invalid`           | Skips the candidate                                                          |
| No refusal                             | Ordinary failure, unless the native class was `usage_limit`                  |

After any content, tool call, plan or input request, no refusal relaunches the
run. A superseded lease is cancelled and released. A session releases its
lease when it closes, and touches it every 10 minutes while it lives so the
proxy's 30-minute idle eviction does not drop a pin during long local tool
work. A later explicit turn on an inactive established pin acknowledges a
latched refusal with `resume(expectedRefusalVersion)`, using the version it
just read.

Limits: the proxy and wrapper slices must be reviewed and deployed before any
instance opts in. Until then the route example keeps its approved order, and a
`codex_pool` entry would only be skipped as unverified. T3 tests use a fake
launcher; an opt-in test (`CODEX_T3_CONTRACT_DIR`) validates T3's requests and
the `pool-launch` payload against the wrapper's own contract module. No live
proxy, credential or quota race is exercised.

The `opencode-t3` launcher that loads a Kimi secret only inside the child
process still needs wrapper integration. It uses healthy fallbacks or waits;
this fragment alone cannot admit it. No wrapper, credentials or live settings
are changed by this feature.

ACP does not expose quota or pin a pooled account. Copilot's ACP integration
therefore reports unsupported; neither a GitHub login nor another account's
usage establishes its runtime capacity. Configure a healthy native fallback or
leave the task waiting. Antigravity's existing dashboard windows currently lack
a reliable mapping to the selected runtime model and also remain unverified.

### Recovery and restart boundary

Before useful work, bound-launch error items are held until the trusted recovery
outcome is known. A recovered quota refusal is omitted; an ordinary failure,
nonfatal warning, or successful turn retains the error items in order. Both
terminal failures and startup/stream transport failures use this decision.
`model_mismatch`, `invalid_request`, `transport_unsupported`, authentication and
unclassified upstream errors remain ordinary errors. Unknown actual quota or
identity (`capacity_unverified`, `quota_unverified`, `binding_changed`) remains
fail-closed.

A pending lease that expires while the launcher starts re-enters admission on
the same logical task. Reopened SQLite/service instances re-evaluate pending
launches before opening a provider. Completed launch bindings also remain on
subsequent turns and restart continuations sharing that native thread; they
must never resume through an ordinary unpinned launcher. Useful output, tools,
plans and input requests permanently close the launch retry boundary, including
in the final persisted run.

The v2 proxy stores bindings in memory, and the wrapper refuses `pool-launch`
for an established binding. Consequently a T3 process restart cannot reopen an
established native pin through this launch-only protocol, even when the proxy
still has the binding. A proxy restart likewise loses the pin. These sessions
stop/fail explicitly rather than change account or replay previous work.
Transparent established-session restart would require a separately verified
resume capability in the wrapper/proxy protocol; it is not implemented here.
The guarantee covers quota at launch, not arbitrary mid-task infrastructure loss.

### Account-scoped throttle limitation

T3 can progress to another account on the same model when an authenticated
`throttled` refusal supplies `quotaScope: "account"` and canonical quota domains.
A model-wide `model_capacity` skips the candidate. The current proxy's
`codexDelegatedFailure` emits `throttled/transient` with no account domains for
`rate_limit_exceeded`, `rate_limit_error` and `slow_down`; `boundError` attaches
domains only for account scope. This cannot distinguish account-specific
throttle from a shared throttle. T3 conservatively skips that candidate instead
of guessing independence. Full account-throttle fallback therefore remains
blocked on a trustworthy producer scope/domain primitive. Exhaustion fallback
and consumer handling of an explicitly account-scoped throttle are covered by
orchestration tests.

### Canonical Codex account evidence

Native Codex maps backend `response.account_id` to `account/rateLimits/read`
`accountId`, and exposes `ordinaryUsageAllowed` only when backend account and
user match active authentication. The proxy uses OAuth metadata `account_id`
for `Chatgpt-Account-Id`, rejects supplied usage-response account mismatches,
and emits `codex:credential:<account_id>`. These are backend workspace/account
identities, not email, auth-file ID, provider-instance ID or binding ID. Native
missing/null permission or identity remains unverified. An authoritative
weekly-only allowance is valid; primary/secondary are positions, not a
mandatory five-hour/weekly pair.

Source inspection: native Codex revision
`83086188ae0614bd882818ff1aa23f3194962012`,
`codex-rs/app-server/src/request_processors/account_processor.rs`
(`get_account_rate_limits_response`) and `codex-rs/backend-client/src/types.rs`;
proxy revision `d523fa86a409835223ee4b8be5bca6bf52f4122e`,
`sdk/cliproxy/auth/delegated_launch.go` (`launchAccount`, `probe`,
`decodeLaunchUsage`) and `internal/runtime/executor/codex_executor_terminal.go`.
Synthetic native-schema fixtures prove weekly-only admission, withheld permission
refusal, canonical pool/direct alias exclusion and independent same-model
capacity. This is source/schema evidence, not a live credential comparison.


Protocol 2 carries `attemptedAccountDomain` separately from depletion scope.
For `throttled/transient`, T3 verifies this against the admitted binding and
persists `launch:attempt:<canonical-domain>` in the existing launch block set.
Only at prepare does that marker become an account exclusion. Direct aliases
are skipped too; neither path calls the account exhausted. Existing generation,
60-second block expiry, request identity, 64-domain prepare bound and useful-work
freeze still apply. Global model capacity skips the candidate. Missing identity
cannot unlock same-pool traversal; malformed/foreign identity fails closed.
The protocol setting is `codex-t3-pool-v2`; all three matching layers are required.
Old protocol replies/bindings are incompatible and are not reinterpreted.

The actual Go HTTP-executor fixture exports throttle/capacity states; the real
Python wrapper validates and re-emits them; `CodexPoolControl.test.ts` consumes
those envelopes when `QUOTA_CONTRACT_EXPORT` is set. Persisted orchestration
fixtures cover same-model retry, duplicate dispatch and fresh-layer restart.
The delayed-helper fixture uses a synchronized helper process and virtual clock;
expired pending launch returns to admission/wait without exhaustion or failed child.
Slow-helper performance remains unproven; no lease renewal or credential cache was added.
