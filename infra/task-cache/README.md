# Shared Vite Task cache

[Alchemy](https://alchemy.run) manages the `T3TaskCache` stack: the `t3-task-cache` Worker, its D1 index, private R2 bucket, rate limits, and cleanup schedule. The production stack adopts the existing resources and preserves their data and repository authorization policy. D1 and R2 have a retain removal policy.

The Worker uses Effect services for request handling, developer authentication, bounded concurrency, deadlines, and cleanup. The pinned [upstream protocol package](https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare/tree/5b06c2c10d84ea441735ba07c46f6d1b7cb2ff3b) supplies the experimental wire format, streaming upload, GitHub OIDC validation, and atomic D1 publication. Keeping that adapter preserves compatibility with existing cache entries.

Vite+ 1.3 includes an experimental remote client even though its TypeScript configuration and CLI help omit it. The native client reads `run.cache.remote.url`, `VP_REMOTE_CACHE_URL`, and `VP_REMOTE_CACHE`. An opt-in Node preload patches the Vite+ JavaScript entrypoint in memory and invokes an optional repository hook before and after the native task runner. The global executable and PATH are unchanged. Vite config loads saved credentials into its in-memory remote URL, and the hook selects the native cache mode and exports task summaries. Saved credentials are never exported into task environments. Normal dependency installs do not patch Vite+. The hook is installed only by explicit maintainer setup or our own CI; without credentials it does not collect or queue telemetry.

## Deploy

Install dependencies with `vp install`, then authenticate with Alchemy's Cloudflare profile. Alternatively, provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through your environment. Alchemy stores deployment state remotely with `Cloudflare.state()`.

```sh
cd infra/task-cache
alchemy deploy --stage prod
```

The stack reads read-only credential digests from `~/.config/t3-task-cache/readers.json` (or `READER_KEYS`) and writer digests from `~/.config/t3-task-cache/writers.json` and supplies them as a redacted Worker secret. Preserve that file to administer existing writers. Deployment uses the `prod` stage and the existing endpoint in `.task-cache.json`. The upstream protocol is loaded only inside the Worker runtime and bundled by Alchemy, so deployment runs on Node without an extra TypeScript loader. An explicit `DEVELOPER_KEYS` environment variable overrides the local registry, including on deployment hosts without that file. Deployment fails when neither source exists, so a missing local file cannot silently revoke existing writers.

The production database’s `scopes` and `deployment` records control repository identity, push branch, quotas, and retention. `pull_requests` explicitly enables same-repository PR uploads targeting the configured `branch`; `writes_enabled` disables all artifact uploads, including those from maintainers. Telemetry accepts reports from other PR bases without granting artifact writes. Provisioning a separate cache requires its own repository policy; a new empty database does not grant uploads.

The CI read identity is named `ci-reader`. Its raw token belongs in the GitHub repository secret `T3_TASK_CACHE_READ_TOKEN`; `readers.json` maps that name to the token’s SHA-256 hex digest. To rotate it, replace that digest, deploy, then replace the GitHub secret. Keep the optional private `ci-reader.json` file as `{ "name": "ci-reader", "token": "…" }` for the smoke test to verify read-only restoration; without it, smoke uses the operator’s saved credential. Never commit these files. The read credential cannot upload artifacts or telemetry. Release jobs lack OIDC and their telemetry is not recorded.

## Add a contributor or machine

```sh
node infra/task-cache/scripts/manage.ts add-writer maria
```

This updates the local writer registry and writes `~/.config/t3-task-cache/maria.json`. Run `alchemy deploy --stage prod` from `infra/task-cache` to apply the registry, then transfer that file through a private channel. The recipient runs:

```sh
bash infra/task-cache/install.sh
```

The installer prompts for the endpoint, developer name, and token (hidden), verifies authentication with an empty telemetry report, and saves credentials with mode `0600`. It installs the hook and credentials once in the home directory and enables the preload through `NODE_OPTIONS` in shell startup files. Open a fresh shell after setup. New worktrees and dependency reinstalls automatically use the same hook; no checkout or executable is modified. Existing long-running agents need to restart or inherit the updated environment. Rerunning setup updates the shared hook and restores matching backups from the old on-disk patch.

Uninstall with `bash infra/task-cache/install.sh --uninstall`, then restart existing shells and agents. This removes shell integration, saved client credentials, and queued telemetry. A no-op preload remains for already-running shells that still inherit its path; no cache code runs through it. Administrative writer digests and issued credential files are preserved.

Explicit environment settings take precedence: `VP_REMOTE_CACHE_URL` may contain the URL-encoded developer name and token as HTTP Basic credentials, and `VP_REMOTE_CACHE=read-write` enables uploads. These can be supplied by a secret manager instead of saved credentials. Do not put credentials in shell command history or commit them. Use separate writer names for separate people. Repeating `add-writer` rotates the token; `revoke-writer <name>` removes it. Deploy again to apply either change.

Our repository’s CI explicitly installs the Vite+ hook. Same-repository PRs targeting `main` and default-branch push jobs read and write. PRs targeting other branches read only; fork PRs receive no cache credentials and run normally without remote caching. All artifact reads require authentication, including downloads by blob ID. Trusted maintainers automatically upload artifacts that other authenticated maintainers and CI consume. Deployment credentials are never needed on contributor machines or CI runners.

## Verify

```sh
node infra/task-cache/scripts/smoke.ts
vp run --filter @t3tools/task-cache test
vp run --filter @t3tools/task-cache typecheck
```

The smoke check uploads a unique fixture, restores its output into a cold second directory, changes its input, and confirms recomputation. It also checks that anonymous reads and uploads are rejected. Cacheable commands must run through `vp run`; direct `vp test` or `vp check` invocations do not use this cache.

## Native clients

`/projects/t3code/native-clients/<platform>/<variant>/<expo-fingerprint>` stores simulator and emulator development clients for `scripts/mobile-native-client.ts` in a separate `-native-clients` R2 bucket with 30-day retention. Unlike Vite Task entries, the Expo fingerprint is portable, so a client built on any Mac or Linux machine serves every other one. Readers download; writers upload through R2 multipart in 64 MB parts, because Workers cap request bodies. The uploader's bundle digest is stored as object metadata and checked by the client before it installs anything.

## Current limits

- Vite Task separates operating systems and CPU architectures. macOS results do not satisfy Linux CI; Linux developer machines can populate compatible CI results.
- The current protocol retains one result for each execution key. Competing source versions can overwrite each other's entry. Inputs are validated before reuse, so this causes misses rather than stale hits. Merging to main does not promote or reset the cache.
- A local hit makes no remote request and is not uploaded retroactively. Clear only an isolated worktree's task cache when testing uploads of an already-cached task.
- Production retains results for seven days within an 8 GB budget. Remote errors fall back to execution. `VP_REMOTE_CACHE=off vp run ...` disables the remote tier for one invocation.

## Savings and tracing

Alchemy also owns the `t3-task-cache-traces` Axiom dataset, its ingest-only Worker token, a savings dashboard, and a separate retained D1 database for lifetime counters. Deployment needs an Axiom Alchemy profile or `AXIOM_TOKEN`/`AXIOM_ORG_ID` as well as Cloudflare credentials. Contributor machines never receive the Axiom token.

Both `vp run` and its `vpr` shortcut invoke the hook. The hook observes Vite+'s atomic `last-summary.json` files, including nested runs. It reports package/task names, confirmed local and remote hits, avoided task runtime, developer identity, host, OS/architecture, and CI run ID. It does not send commands, arguments, source paths, environment variables, or task output. Developer identity comes from the authenticated cache writer; CI uses GitHub's verified OIDC actor. Same-repository PRs may upload artifacts as well as telemetry. Fork jobs do not install the hook or report telemetry.

Reports spool locally and retry on subsequent commands. The completion hook queues the final summary, including failed runs. Local runs start a detached, short-lived Node process; CI awaits its bounded flush before the runner can terminate it. Collection or export failures never change the task exit status. No background service is installed. Queues retain at most 2,000 reports, each sent with a three-second timeout and a 15-second budget per flush. Stable report IDs and transactional D1 receipts prevent duplicate lifetime increments. Receipts expire after 31 days; accepted reports must be less than 30 days old. Lifetime totals survive raw trace expiration and are re-exported hourly, including inactive developers and hosts. Collection starts when the hook is installed; existing cache history is not backfilled.

**Saved time means historical task execution time avoided.** It is useful as a compute proxy, but it is not measured CPU time, money saved, or elapsed developer waiting time. Parallel tasks can overlap, and cache lookup/restore overhead is not subtracted. Failed restores contribute no savings. Older Vite+ versions omit the hit source; their confirmed savings are counted under an explicit unspecified tier. Native summary collection is best-effort: interrupted runs or summaries overwritten before observation can be missing. The experimental Vite+ summary schema is tested here and must be checked when upgrading Vite+.

Host labels use `~/.agents/MACHINE` when present, otherwise the hostname. GitHub-hosted runners use their runner OS/architecture class to avoid a new lifetime series for every ephemeral VM. Set `T3_TASK_CACHE_HOST` to override the label, or `T3_TASK_CACHE_TELEMETRY=off` to opt out while retaining remote caching. Re-run the installer to update an existing machine's hook.

Writer administration requires the complete private registry on the administering machine. Copy that registry securely from its administrator before adding a writer on another machine. `add-writer --new-registry` explicitly initializes a new cache; never use it to recover an existing registry.

Node processes running with filesystem permissions must allow the installed preload and hook directory. Remove the task-cache import from `NODE_OPTIONS` for a restricted process that cannot allow those files.

Local telemetry is queued to disk before command exit and uploaded by a short-lived detached Node process. Slow or offline endpoints do not delay `vp run`; unsent reports retry on a later run.
