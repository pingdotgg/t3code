# The server area: `server.*` methods

This map lists every `server.*` method of the contract (`crates/conn-contract/methods.json`,
Conn `b12470dcad`): whether this server serves it, what the T3 server does, where the state
lives, the scope, and what the method needs from outside. Paths are in the Conn monorepo;
`S` is `apps/server/src`, `C` is `packages/contracts/src`. The handlers are in `S/ws.ts`
(lines 2330 to 2705); the scopes are in `S/auth/RpcAuthorization.ts` and
`C/clientRpcPermissions.ts`, and `crates/conn-server/src/scopes/generated.rs` holds them here.

## In short

42 `server.*` methods. 12 are served. 11 are the ACP registry's, and another worker owns them.
19 are not served:

| Needs | Count | Methods |
| --- | --- | --- |
| Nothing from outside, but a large port into other areas | 5 | `getStorageCleanupReport`, `runStorageCleanup` (engine, VCS, terminals); `getDatabaseStorage`, `reclaimDatabaseSpace` (engine store, an offline repair command, a supervisor); `getTraceDiagnostics` (a trace writer) |
| Our own resource sampler | 3 | `getProcessResourceHistory`, `getResourceTelemetryHistory`, `retryResourceTelemetry` |
| Provider files (local reads) and an outside price table | 2 | `getUsageSummary`, `refreshUsageRates` |
| An outside service | 3 | `checkOtlpEndpoint` (a user URL), `getNpmRelease` (npm), `prepareTriage` (GitHub through git) |
| A secret provider that reads secrets | 1 | `checkSecretSource` |
| Changes software on the machine, or a supervisor | 5 | `updateProvider`, `updateServer`, `updateServerWithProgress`, `commitDesktopUpdate` (desktop), `restart` |

Nothing in this area was built without an outside service and without another area's code.
The small leftovers were done instead (see the end).

## Served (12)

| Method | Scope | Here | State |
| --- | --- | --- | --- |
| `server.probe` | orchestration:read | `methods/server.rs` | none |
| `server.getConfig` | orchestration:read | `methods/server.rs`, `environment.rs` | settings, keybindings, providers |
| `server.refreshProviders` | orchestration:read | `methods/server.rs` | provider entries |
| `server.updateSettings` | settings:write | `settings.rs`, checked by `settings-diff.mjs` | `<state>/settings.json` |
| `server.upsertKeybinding`, `server.removeKeybinding` | settings:write | `keybindings.rs` | `<state>/keybindings.json` |
| `server.getHostResources` | orchestration:read | `diagnostics.rs` | none (reads `/proc` or `sysctl`, `vm_stat`) |
| `server.getProcessDiagnostics`, `server.signalProcess` | diagnostics:read; environment:maintain | `diagnostics.rs` | none |
| `server.reportClientActivity` | orchestration:read | `methods/server.rs`: accepted, no background policy | none |
| `server.discoverSourceControl` | orchestration:read | another worker (`conn-source-control`) | |
| `server.listTextGeneratorModels` | settings:write | `methods/text_generation.rs`, `text_generation/` (below) | a model list per generator in memory (at most 32) |

## Not served (19)

### Local state, large ports

- **`server.getStorageCleanupReport`** (stream) and **`server.runStorageCleanup`**:
  `S/storageCleanup.ts` (1,825 lines; `runNow` at 1742). One sweep each hour and on every
  change to `storageCleanup` or `worktreeCleanup` settings or a thread deletion. It removes
  worktrees (by `worktreeKeepWhen`, age, settled age, merged pull request, deleted thread,
  unchanged), browser artifacts and logs by age, and publishes a report of at most
  `REPORT_ENTRY_LIMIT` entries. Scopes: orchestration:read, settings:write. Needs the engine
  (thread shells, settlement, deletions), VCS (dirty state, merged pull requests), terminals
  (live terminals keep a worktree), provider sessions. It deletes user worktrees, so a port
  needs the engine and VCS owners and its own review.
- **`server.getDatabaseStorage`** (stream) and **`server.reclaimDatabaseSpace`**:
  `S/persistence/DatabaseStorage.ts`. Reads `PRAGMA page_size`, `page_count`,
  `freelist_count`, `auto_vacuum`; runs `incremental_vacuum` 1,024 pages a minute; prunes the
  event store every 6 hours (`compacted-at` file). The status carries `compactCommand`
  (`t3 doctor --base-dir ...`). It emits `null` when that command does not target this
  database. Reclaim checks free disk, writes a request file, and restarts through the desktop
  or the background service; the offline `doctor` runs `VACUUM`. Scopes:
  orchestration:read, environment:maintain. Our store (`conn-engine/src/store.rs`) has no
  `auto_vacuum` and there is no offline repair command or supervisor, so an honest status
  would recommend a command that does not exist.
- **`server.getTraceDiagnostics`**: `S/diagnostics/TraceDiagnostics.ts`. Reads
  `<logs>/server.trace.ndjson` and its rotations (10 files of 10 MiB), and aggregates spans,
  failures and slow spans. Without trace files it answers an empty result with
  `trace-file-not-found`. This server writes no traces, so that empty answer would be all it
  could give. Not registered: it would be a stub.

### Our own resource sampler

- **`server.getResourceTelemetryHistory`**, **`server.retryResourceTelemetry`**:
  `S/resourceTelemetry/ResourceTelemetry.ts`. A native `resource-monitor` child samples
  processes each second (5 s on battery, 15 s when constrained, idle without subscribers) and
  keeps 60 minutes (at most 3,600 snapshots, 20,000 entries, 64 MiB). `retry` restarts it.
- **`server.getProcessResourceHistory`**: `S/diagnostics/ProcessResourceMonitor.ts`, a view
  of the same history for the server, its children, provider roots and terminal roots.
- All local, scope diagnostics:read. A port is an in-memory ring of process samples from
  `diagnostics.rs` with a fixed bound, sampled only while a client reads. Not started: it is
  new state that needs a memory measurement, and it is worth less than the items above.

### Provider files and an outside price table

- **`server.getUsageSummary`**, **`server.refreshUsageRates`**: `S/usage/UsageService.ts`.
  Scans provider transcripts (files in the provider homes, such as `~/.claude/projects` and
  `~/.codex/sessions`) into hourly and daily token buckets, with a scan cache in the state
  folder (92 days). Prices come from LiteLLM's table on `raw.githubusercontent.com` (24 h
  cache). Settings: `usagePriceOverrides`, `usageModelAliases`. Without prices it answers
  `pricing.status: "unavailable"`. A local-only port can read the transcripts and report
  `unavailable`; the price fetch is an outside call. Decision for Nick (below).

### An outside service

- **`server.checkOtlpEndpoint`**: `S/observability/OtlpEndpointCheck.ts`. POSTs an empty OTLP
  export to a URL the user gives (5 s, no redirects). Settings `otlpTracesUrl`,
  `otlpMetricsUrl`, `otlpLogsUrl`. This server exports no OTLP.
- **`server.getNpmRelease`**: `S/cloud/npmRelease.ts`. `npm view t3@<spec>`, else
  `registry.npmjs.org`. 32-entry cache, 1 minute.
- **`server.prepareTriage`**: `S/triage/TriageService.ts`. `git ls-remote` and a shallow
  fetch of `github.com/pingdotgg/t3code` at the server's version into `<base>/source/`, then
  writes `<state>/triage/<time>/context.md` and a playbook. A failed clone does not fail it.

### A secret provider

- **`server.checkSecretSource`**: `S/secrets/SecretCheck.ts`. Reads one secret fresh through
  the secret provider (1Password: `op read`), never returns it, and rebuilds the provider
  instances that use it. Our settings keep secret references but have no secret resolver.

### Changes software, or needs a supervisor

- **`server.updateProvider`**: `S/provider/providerMaintenanceRunner.ts` (424 to 723). Finds
  the latest version (`registry.npmjs.org`, `downloads.claude.ai/claude-code-releases`),
  checks a compatibility manifest, then runs the install command the CLI was installed with
  (`npm i -g`, `pnpm add -g`, `bun i -g`, `yarn global add`, `volta install`, `brew upgrade`,
  `mise upgrade`, or `claude update`, `codex update`), 30 minute timeout. No credentials.
- **`server.updateServer`**, **`server.updateServerWithProgress`**: `S/cloud/selfUpdate.ts`.
  Downloads a release from `github.com/pingdotgg/t3code/releases` (or a mirror), checks its
  checksum, runs a preflight on the database, and asks the launcher or the desktop to switch.
- **`server.commitDesktopUpdate`**: asks the desktop over its control channel; fails without
  one.
- **`server.restart`**: `S/serverRestart.ts`. T3 acknowledges the request, then exits so its
  supervisor starts it again. This server serves and advertises it only when systemd's
  `t3.service` owns this process and has `Restart=always` or `Restart=on-failure`.

## Provider sign-in, sign-out and install (map only)

These are `provider.*` methods, outside `server.*`, but they decide the same rule: only the
official binary or SDK touches a credential.

| Provider | What the T3 server does | Stores | Official way |
| --- | --- | --- | --- |
| Claude | No sign-in method. The user signs in with the CLI. | nothing | `claude` itself (`/login` in the CLI) |
| Codex (standard) | No sign-in method; watches `auth.json` for changes. | nothing | `codex login`, `codex logout` |
| Codex (managed ChatGPT) | Runs OAuth itself (`S/provider/CodexChatGptAuth.ts`): discovery at `auth.openai.com`, a loopback callback, PKCE, token exchange, refresh, revoke. Gives the token to `codex` through a private socket broker (`CodexManagedTokenBroker.ts`). | `{accessToken, refreshToken, idToken, ...}` in `<state>/secrets/provider-auth-<hash>` (0600) | `codex login` writes its own `auth.json` |
| Codex install (`provider.install.*`) | Downloads pinned `rust-v0.166.0` archives from GitHub releases, checks SHA-256, unpacks to `<base>/tools/codex/<version>` | `active.json`, `.install-complete.json` | the vendor installer or npm |
| Cursor | Cursor SDK `Cursor.auth.login`; stores what the SDK returns | instance store | the SDK |
| Antigravity | through the Antigravity CLI runtime | not verified | the CLI |
| ACP registry | the agent's `authenticate` method, a terminal login, or env secrets | settings secrets | the agent |

Analytics (`S/telemetry/AnalyticsService.ts`, not an RPC method) posts events to
`ingest.t3.codes` and derives its distinct id from a hash of `~/.codex/auth.json`'s account
id or `~/.claude.json`'s user id. This server sends no analytics.

## What `ServerConfig` and the capabilities advertise

The T3 server builds `ServerConfig` in `S/ws.ts` (1806 to 1920) and the capabilities in
`S/environment/ServerEnvironment.ts` (226 to 306). It advertises these for this area:
`storageCleanup`, `storageCleanupRun`, `databaseStorage`, `otlpEndpointCheck`,
`secretSourceCheck`, `triage`, `npmReleaseLookup`, `usagePriceOverrides`, `usageModelAliases`,
`modelCatalogRefresh`, and, when they apply, `serverSelfUpdate`, `serverSelfUpdateProgress`,
`serverInstallation`, `desktopAppUpdate`, `serverRestart`.

This server advertises `serverRestart` when its supervisor can restart it; the key is absent
otherwise. The other capabilities in this area remain unserved. What else it advertises
(`environment::capabilities`, `config_flags`): `repositoryIdentity: false`,
`attachmentUploads`, `fileAttachments`, `threadForceStop`, `shellThreadFamilies`,
`shellOlderSettled`, `ignoredFileListing`, `ignoredFileSearch`; flags `shellThreadFamilies`,
`shellOlderSettled`, `threadLinkMetadata`, `threadFind`. A test in `environment.rs` holds
that list.

## Decisions for Nick

1. **Text generator models** (`listTextGeneratorModels`): decided by Nick on 2026-11-14, serve
   them as the T3 server does. Served (see "Text generators" below).
2. **Usage figures** (`getUsageSummary`). Options: read provider transcripts locally and
   report prices `unavailable`; also fetch LiteLLM's price table as the T3 server does; or
   leave it.
3. **Sign-in and install.** The T3 server holds tokens only for managed ChatGPT (its own
   OAuth) and Cursor (what the SDK returns). `provider.auth.*` is served as T3 serves it for
   Claude, Codex and Grok: a `ProviderSetupError`, and users run `codex login` and the
   `claude` CLI (status.md, "Provider sign-in"). Open: run the Cursor sign-in in the SDK
   host, where only the SDK touches the credential.
4. **Updates and restart.** All of them change software or need a supervisor that Orbit
   containers do not have. Options: leave them unserved and unadvertised (now); or let Orbit
   update the image, which needs no server method.
5. **Storage cleanup and database storage.** Local, but they delete worktrees and need the
   engine, VCS and store owners. Options: port them as one task with those owners; or leave
   them until a container's disk use shows the need.

## Leftovers of this area (done 2026-11-14)

- **Payload limits.** The generated contract types carry no schema checks. `conn-support/src/input.rs`
  applies the length, pattern, range and entry-count checks of `assets.createUrl`,
  `server.listTextGeneratorModels` (the `ProviderInstanceId` of `id`, the base URL's length),
  `terminal.open` and `terminal.attach`, generated from the schema AST by
  `tools/gen-upstream.mjs`. A terminal env entry with a bad key (`1FOO`) is dropped, as
  Effect's `Record` decode drops it; more than 128 entries, a key over 128 or a value over
  8,192 UTF-16 units fail. Proof: `tools/limits-cases.json` (43 cases) through the T3
  contract's decode (`limits-diff.mjs`, a check step) and through `limits::check` (a test).
  Add a method tag to `LIMITED_METHODS` to cover it. The hand limits in `methods/files.rs`
  could move to this table. Difference left: Effect trims a `TrimmedNonEmptyString` before it
  checks the length; this check reads the string as sent.
- **Unreaped `git` children.** No spawn site leaves a child unreaped: each waits, and a
  dropped run kills its child through `kill_on_drop`, which tokio reaps. A test in
  `conn-vcs` (`cancelled_and_timed_out_children_are_reaped`) proves both kill paths with `ps`.
- **The Claude model list by CLI version** (`S/provider/ClaudeModelCatalog.ts`,
  `resolveClaudeModelsForVersion`): the T3 server drops a model whose `minVersion` or
  `maxVersionExclusive` the installed CLI's version misses, and with no known version it drops
  every bounded model. It needs the CLI's version from a probe of the executable the session
  will run, which is provider work (`conn-provider-claude`, `server_provider_entry` reports
  `version: null`). Not built here.

## Text generators (served 2026-11-14)

`server.listTextGeneratorModels` and thread titles through a text generator, in
`crates/conn-server/src/text_generation/` (`S/textGeneration/TextGenerators.ts`,
`textGeneratorDrivers.ts`, `packages/provider-core/src/server/textGeneration*.ts`).

- **What the server sends.** OpenAI-compatible: `GET <baseUrl>/models` and
  `POST <baseUrl>/chat/completions` with `{"model","messages":[{"role":"user","content"}]}`,
  `authorization: Bearer <key>` only when a key is set. Anthropic: `GET <baseUrl>/models?limit=1000`
  (`&after_id=<last_id>`, at most 10 pages) and `POST <baseUrl>/messages` with
  `{"model","max_tokens":8192,"messages":[…]}`, `x-api-key` (also when empty) and
  `anthropic-version: 2023-06-01`. JSON bodies carry `content-type: application/json`. One
  connection per request, no redirect followed (a redirect reads as "Couldn't reach"), answers
  read up to 8 MiB. Timeouts: 25 s for a model list with all its pages, 2 minutes for a reply.
- **When.** The client lists models (wizard, pickers, refresh, test); a test also sends
  "Reply with OK." to one model. A thread title is generated for the first message of a thread
  launched with `generateTitle`, and on `regenerateTitle`, when the title model
  (`textGenerationModelSelection`, or the project's override) is a text generator.
- **Agent title models.** The default title model is Codex, and Claude can be chosen; the T3
  server then asks that provider's CLI or SDK (`ClaudeTextGeneration.ts`,
  `CodexTextGeneration.ts`, also Antigravity, Grok and OpenCode). This server asks the
  provider instance through `Provider::generate_text` (the prompt, T3's output schema text
  generated as `TITLE_OUTPUT_SCHEMA`, the whole selection, the thread's folder and its image
  attachments). Codex implements it (`codex mcp list`, then `codex exec`, as T3; proven by the
  Codex conformance check, `titleListed` and `titleFallback`). A provider that does not
  (Claude, for now, and Grok) fails the request without a call: a first title keeps its seed
  (a short `titleRegeneration` shows), a regenerate reports "This server generates titles
  only with a text generator. Choose one as the title model in Settings." Not built: T3's
  fallback to another provider when the chosen one is unusable
  (`fallbackTextGenerationModelSelection`).
- **The key.** In the T3 server's secret store, `<state>/secrets/text-generator-<b64url
  id>-<b64url "apiKey">.bin`, as every settings secret (see `docs/conn-only-areas.md`,
  "Settings secrets"). A secret provider reference cannot be read (no secret provider here)
  and fails with T3's `SettingsSecretUnresolvedError` text. Only the request header holds the
  key (`conn_source_control::Secret`); no `Debug`, error or log shows it.
- **Proofs.** 22 unit tests (the cases of `TextGenerators.test.ts` on a loopback stub, the
  title retries on a paused clock, the project override); the client's decoders accept both
  answers (`effect-client.mjs`); `textgen-diff.mjs` (a check step) runs T3's own code and
  ours against one loopback stub: 102 comparisons of answers, request method, path, headers
  and body bytes, prompts, thread contexts, sanitized titles and the model order.
- **Headers.** Each request carries what Node's fetch adds for the T3 server: `accept: */*`,
  `accept-language: *`, `sec-fetch-mode: cors`, `user-agent: node`, `accept-encoding: gzip,
  deflate`, `connection: keep-alive` (this client still opens one connection per request).
  A gzip or deflate answer (zlib or raw) is decoded off the runtime thread; more than 8 MiB
  after decoding reads as an answer it could not read. `textgen-diff.mjs` compares all
  headers but `host` and `content-length`, and has gzip, deflate and raw deflate answers.
- **Title context.** Assistant quotes (`[Assistant quote](t3-citation://v1/...)`) become their
  text and comment (`assistantCitationsToPlainText`, `text_generation/citations.rs`).
- **Fallback.** None is needed here: T3 falls back to another model only when the chosen
  title model is an agent provider that cannot run, and its fallbacks are agent providers.
  A chosen text generator is always used as it is, in both servers.
- **Differences left on purpose.** No managed policy, so no allow-list refusal. The model
  cache is capped at 32 lists. Titles: no fork source section (it needs the engine's fork
  chain with run ordinals, `ThreadTitleRegenerationService.forkSource`), no linked pull
  request or issue context (`ThreadTitleLinks.ts`: needs the source control link lookup of
  each host, which `conn-source-control` does not have yet).
- **Managed policy (mapped, not built).** The T3 server reads `/etc/t3code/policy.json` on
  Linux (`/Library/Application Support/T3Code/policy.json` on macOS; the Windows registry),
  `apps/server/src/policy/` (about 2,900 lines with tests): locked settings, provider allow
  lists and limits, a runtime-mode ceiling, update rules and `limits.webhookTasks`. It applies
  in a container when the image has that file. Not built: it is not small, and whether Orbit
  images will carry one is Nick's call.
- **Stricter than the T3 server, on purpose** (security faults T3 also has; see
  `docs/status.md`, "Faults found in the T3 server"):
  - *The saved key and the marker.* An unsaved config whose key is the redaction marker gets
    the saved key only when the caller holds `providers:manage`; otherwise no key is sent
    (`methods/text_generation.rs`). T3 fills it in for any `settings:write` caller, to any
    host. A legitimate user loses nothing: only the generator edit form sends the marker, and
    saving that form needs `providers:manage`.
  - *Link-local hosts.* A base URL whose host resolves to a link-local address
    (169.254.0.0/16, fe80::/10, where a cloud host serves its metadata and credentials) is
    refused: the check runs on the addresses of the one lookup, and only addresses that pass
    are dialled (`LinkLocal::Refuse` in `conn_source_control::http`). The client sees "Couldn't
    reach …". Loopback and private ranges stay open for Ollama, LM Studio and similar. A user
    loses only a model server on a link-local address.

### Other uses of text generation in the T3 server

| Use | Source | Here |
| --- | --- | --- |
| Thread titles | `orchestration-v2/ThreadTitleRegenerationService.ts` | built: text generators and Codex |
| Commit messages | `git/GitManager.ts:2210` (`generateCommitMessage`) | not built: needs the `git.*` stacked actions (source control worker) |
| Pull request title and body | `git/GitManager.ts:2438` (`generatePrContent`) | not built: needs pull request creation |
| Worktree branch names | `orchestration-v2/ThreadLaunchService.ts:475` (`generateBranchName`) | not built: needs prepared runs (worktree preparation is not built) |
| Review guides | `pullRequest/PullRequestReviewGuideService.ts` | never through a text generator: T3 requires Codex or Claude |
| Transcript cleanup | `speech/postProcessing.ts` | not built: no speech methods |
