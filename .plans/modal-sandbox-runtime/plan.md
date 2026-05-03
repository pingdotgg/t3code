# Plan: Modal Sandbox Runtime

> [!IMPORTANT]
> **Instructions for Agents**
>
> This plan is executed phase-by-phase. After completing each phase:
>
> 1. Update **Implementation Notes** - record deviations from the plan, key decisions made during implementation, and anything surprising or non-obvious.
> 2. Update **Implementation Footprint** - list all files created and modified during the phase.
> 3. Check off **acceptance criteria** - mark completed items with `[x]`.
>
> Read the PRD and the relevant **References** before starting each phase. Phases with no blockers can be implemented in parallel.

## Source Documents

- [PRD](./prd.md)
- [Domain Context](../../CONTEXT.md)
- [ADR 0001: Limit v1 Orchestrator autonomy to Task coordination](../../docs/adr/0001-limit-v1-orchestrator-autonomy.md)
- [ADR 0002: Convex owns Task state, T3 owns runtime state](../../docs/adr/0002-convex-owns-task-state-t3-owns-runtime-state.md)
- [ADR 0003: Refactor Orchestrator schema around Tasks](../../docs/adr/0003-refactor-orchestrator-schema-around-tasks.md)
- [ADR 0004: Cloud Sandboxes are Task execution capacity](../../docs/adr/0004-cloud-sandboxes-are-task-execution-capacity.md)
- [Modal/Ramp reference architecture](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal)
- [Modal Sandbox docs](https://modal.com/docs/guide/sandbox)
- [Modal Sandbox reference](https://modal.com/docs/reference/modal.Sandbox)
- [Modal npm package](https://www.npmjs.com/package/modal)

## Durable Architectural Decisions

- Cloud Sandboxes are Task execution capacity, not parallel attempts for one prompt.
- The Orchestrator owns Task State, Task Status, External Links, current Primary Thread, and Work Session records.
- T3 Code owns Sandbox runtime state, Worktree state, Thread state, Coding Agent state, git execution, and full Thread transcripts.
- The Sandbox module is the deep module for Task runtime materialization. Callers ask it to materialize, reconnect, archive, or inspect Task Sandboxes; callers do not sequence Modal operations directly.
- Modal is the first production Cloud Sandbox Provider. Local Sandbox support remains as a compatibility and test adapter.
- A Cloud Sandbox runs a T3 Code server/runtime inside the Sandbox. The Workspace connects to it as a T3 Code Environment.
- Browser access is represented in descriptors as a deferred Sandbox Service, but browser/VNC functionality is out of the first implementation.
- Project configuration selects Sandbox Provider, Modal app/environment, image, resources, Snapshot policy, setup scripts, required Sandbox Services, and allowed secrets.
- Modal provider details stay behind an adapter. Human-facing language remains Sandbox, Cloud Sandbox, Worktree, Sandbox Service, and Sandbox Snapshot.

## MVP Scope Reset: Modal Task Execution Tracer Bullet

As of the Task Intake and PR orchestration MVP, the system can create a Task from a Slack thread, materialize a local T3 runtime, execute the Coding Agent, create a branch/worktree, open a draft PR, store the `github_pr` link, and reply to Slack with the PR URL. The next MVP is not the full Sandbox platform. The next MVP is to move that proven path into a per-Task Modal Sandbox.

The target proof is:

1. A Slack thread creates one Convex Task and one Work Session.
2. The Work Session selects `sandboxProvider: "modal"` from Project configuration.
3. T3 allocates or reconnects one named Modal Sandbox for that Task/Work Session.
4. The Modal Sandbox runs a T3 Code server/runtime inside the Sandbox.
5. The Primary Thread and Coding Agent execute inside the Modal Sandbox, not on the Operator machine.
6. PR ensure calls the Task runtime endpoint for that Work Session, so git status, commit, push, and PR creation run against the Cloud Worktree.
7. Convex stores the Sandbox reference and `github_pr` link.
8. Slack receives the completion reply with the PR URL.

For this MVP, defer:

- Sandbox Snapshots and image acceleration.
- Task-scoped Convex deployments as a Sandbox Service.
- Browser, VNC, desktop streaming, and dev-server tunnels beyond the T3 runtime endpoint.
- Workspace UI polish beyond persisting enough descriptors for inspection.
- Full archival/artifact capture beyond safe Modal timeout/idle-timeout defaults.
- Email intake and Linear live E2E unless needed to validate shared routing.
- Sophisticated concurrency controls beyond a conservative per-project/provider guard if implementation needs one.

The critical reconciliation is runtime routing. The Orchestrator cannot keep using one global `T3_EXECUTION_BRIDGE_BASE_URL` for all Task operations once Tasks run in Modal. Materialization may still enter through a control bridge, but follow-up turns, lifecycle callbacks, PR ensure, reconnect/status, and archive must resolve the Work Session's active T3 runtime endpoint from persisted Sandbox/Service state.

## Revised MVP Phase Map

Use this phase map for the next implementation slice. The older, broader phases below remain useful as backlog context, but the MVP should optimize for this tracer bullet first.

1. **Persist Sandbox State And Runtime Endpoint**: store provider, sandbox id/ref, status, environment id, `t3-runtime` endpoint, branch, and worktree path on Work Sessions/Task Threads. Add Task Events for provisioning/ready/failed.
2. **Project Sandbox Provider Selection**: add Project config for `sandboxProvider`, minimal Modal app/environment/image/resources, and pass it into materialization. Keep local as the default and test adapter.
3. **Runtime Routing Registry**: teach Orchestrator T3 client calls to target the Work Session runtime endpoint for continue/PR ensure after materialization. Keep the control bridge only for initial allocation until Modal can allocate itself from a durable service.
4. **Modal Provider Minimal Adapter**: create/reconnect a named Modal Sandbox, start T3 runtime in it, wait for readiness, return a `SandboxDescriptor` and `t3-runtime` service endpoint. Use fake Modal client tests first.
5. **Remote T3 Handshake**: the Modal T3 runtime creates the Cloud Worktree/Thread and starts the Coding Agent inside the Sandbox. The Operator machine should not create the task worktree for Modal tasks.
6. **Slack Modal E2E**: run a tiny Slack task through Modal and verify one draft PR plus one Slack completion reply.
7. **Cleanup Guardrails**: add idle timeout, basic status/reconnect, and a manual terminate/archive path. Do not block the MVP on full artifact archival.

## Contract Shape

The contract is split intentionally:

- `packages/contracts` owns schema-only wire contracts.
- `packages/sandbox` owns provider-neutral runtime interfaces and pure helpers.
- `apps/server/src/sandbox` owns T3 server adapters, persistence integration, Modal SDK wiring, and local runtime integration.
- `apps/orchestrator` stores Task-level references and calls the T3 execution bridge.

### New Contract Schemas

Add schema-only definitions to the contracts package and re-export them from the package root.

Core identifiers:

- `SandboxId`: branded non-empty string generated by T3 for product/runtime identity.
- `SandboxProviderKind`: `"local" | "modal"`.
- `SandboxProviderRef`: stable provider reference.
  - `providerKind`
  - `externalId`
  - optional `appId`
  - optional `appName`
  - optional `environment`
  - optional `name`
- `SandboxSnapshotId`: branded non-empty string.
- `SandboxServiceId`: branded non-empty string.
- `SandboxArtifactId`: branded non-empty string.

Lifecycle enums:

- `SandboxLifecycleStatus`: `"requested" | "queued" | "provisioning" | "starting" | "ready" | "running" | "idle" | "archiving" | "archived" | "failed" | "terminated"`.
- `SandboxServiceStatus`: `"requested" | "provisioning" | "ready" | "degraded" | "failed" | "stopped"`.
- `SandboxSnapshotStatus`: `"missing" | "creating" | "ready" | "stale" | "failed"`.
- `SandboxFailureKind`: `"provider_unavailable" | "capacity_exhausted" | "auth_failed" | "snapshot_failed" | "worktree_failed" | "service_failed" | "runtime_failed" | "timeout" | "invalid_request" | "unknown"`.

Descriptors:

- `SandboxResourceSpec`
  - `cpu`
  - `cpuLimit`
  - `memoryMiB`
  - `memoryLimitMiB`
  - `gpu`
  - `timeoutMs`
  - `idleTimeoutMs`
  - `regions`
- `SandboxWorktreeDescriptor`
  - `workspaceRoot`
  - `worktreePath`
  - `branch`
  - `baseBranch`
  - optional `baseCommit`
  - optional `headCommit`
- `SandboxSnapshotDescriptor`
  - `snapshotId`
  - `providerRef`
  - `status`
  - `projectKey`
  - `sourceBranch`
  - optional `sourceCommit`
  - `createdAt`
  - optional `expiresAt`
  - optional `setupSummary`
  - optional `failure`
- `SandboxServiceDescriptor`
  - `serviceId`
  - `kind`: `"t3-runtime" | "convex" | "dev-server" | "browser" | "terminal" | "custom"`
  - `status`
  - optional `label`
  - optional `endpointUrl`
  - optional `healthCheckUrl`
  - optional `endpoints`: typed endpoint descriptors with `url`, `protocol`, `accessMode`, and auth metadata.
  - optional `metadata`
  - optional `failure`
- `SandboxArtifactDescriptor`
  - `artifactId`
  - `kind`: `"log" | "command-output" | "diff" | "screenshot" | "trace" | "archive" | "custom"`
  - `label`
  - optional `url`
  - optional `path`
  - `createdAt`
- `SandboxDescriptor`
  - `sandboxId`
  - `providerKind`
  - `providerRef`
  - `status`
  - `taskId`
  - `workSessionId`
  - `project`
  - `resources`
  - optional `environment`
  - optional `worktree`
  - optional `snapshot`
  - `services`
  - `artifacts`
  - optional `failure`
  - optional `idempotencyKey`
  - `createdAt`
  - `updatedAt`

Runtime selection:

- `SandboxRuntimeSelection`
  - `providerKind`
  - optional `resources`
  - optional `environment`
  - optional `providerConfig`: Modal-oriented non-secret config such as app name, image tag, runtime port, bootstrap command reference, config version, and allowed secret names.

Execution bridge request/response changes:

- Extend `TaskRuntimeMaterializeRequest` with:
  - `sandbox`: provider selection and resource hints.
  - `services`: requested Sandbox Services.
  - `idempotencyKey`: stable Task materialization key.
- Extend `TaskRuntimeMaterializeResponse` with:
  - `sandbox`: `SandboxDescriptor`
  - `environment`: `ExecutionEnvironmentDescriptor`
  - `services`: `SandboxServiceDescriptor[]`
  - existing `t3ProjectId`, `t3ThreadId`, `branch`, and `worktreePath` remain for compatibility.
- Add `TaskRuntimeReconnectRequest/Response` for reconnecting to an existing Cloud Sandbox Environment.
- Add `TaskRuntimeArchiveRequest/Response` for artifact capture and Sandbox teardown.
- Add `TaskRuntimeSandboxStatusQuery/Response` for Workspace and Orchestrator status refresh.
- Add `TaskRuntimeSandboxLifecycleEvent` so Sandbox lifecycle/status updates are separate from Coding Agent run lifecycle updates.
- Include optional provider refs on reconnect/archive/status requests and optional Sandbox/Environment refs on PR ensure requests.

### Package Interface

`packages/sandbox` exposes a small runtime interface and pure helpers:

- `SandboxProvider`
  - `materializeTaskRuntime(input): Effect<SandboxMaterializationResult, SandboxError>`
  - `reconnect(input): Effect<SandboxReconnectResult, SandboxError>`
  - `getStatus(input): Effect<SandboxDescriptor, SandboxError>`
  - `archive(input): Effect<SandboxArchiveResult, SandboxError>`
  - `terminate(input): Effect<SandboxTerminateResult, SandboxError>`
- `SandboxProviderRegistry`
  - resolves `"local"` or `"modal"` to an adapter.
- `SandboxLifecycle`
  - pure transition helpers and status classification.
- `SandboxNames`
  - provider-safe names, tags, branch names, idempotency keys.
- `SandboxSnapshots`
  - pure Snapshot selection and staleness helpers.
- `SandboxServices`
  - service request normalization and readiness aggregation.
- `SandboxErrors`
  - stable tagged errors and retry classification.
- `FakeSandboxProvider`
  - deterministic test adapter.

The package should not import `apps/server`, Convex, HTTP server code, or Modal. Modal-specific imports live in `apps/server/src/sandbox/modal`.

## Module Schema

### New Package: `packages/sandbox`

New files:

- `packages/sandbox/package.json`
- `packages/sandbox/tsconfig.json`
- `packages/sandbox/src/index.ts`
- `packages/sandbox/src/Provider.ts`
- `packages/sandbox/src/Errors.ts`
- `packages/sandbox/src/Lifecycle.ts`
- `packages/sandbox/src/Names.ts`
- `packages/sandbox/src/Snapshots.ts`
- `packages/sandbox/src/Services.ts`
- `packages/sandbox/src/FakeSandboxProvider.ts`
- focused tests beside each module.

Exports:

- `"."`: provider-neutral interfaces, helpers, and fake adapter.
- No barrel export from `@t3tools/shared`; keep `packages/sandbox` as its own workspace package.

Dependencies:

- `@t3tools/contracts`
- `effect`
- test/dev dependencies matching existing package patterns.

### Contracts Package

New or modified files:

- Add schema-only Sandbox contracts.
- Export the contracts from the root index.
- Extend execution bridge contracts with Sandbox descriptors.
- Add contract tests for defaults, decoding, and backwards-compatible response shape.

### T3 Server Sandbox Runtime

New files:

- `apps/server/src/sandbox/Services/SandboxRuntime.ts`
- `apps/server/src/sandbox/Services/SandboxProviderRegistry.ts`
- `apps/server/src/sandbox/Layers/SandboxRuntimeLive.ts`
- `apps/server/src/sandbox/Layers/SandboxProviderRegistryLive.ts`
- `apps/server/src/sandbox/Layers/LocalSandboxProvider.ts`
- `apps/server/src/sandbox/modal/ModalClient.ts`
- `apps/server/src/sandbox/modal/ModalSandboxProvider.ts`
- `apps/server/src/sandbox/modal/ModalTypes.ts`
- `apps/server/src/sandbox/modal/ModalErrors.ts`
- `apps/server/src/sandbox/modal/ModalSnapshots.ts`
- `apps/server/src/sandbox/modal/ModalServices.ts`
- `apps/server/src/sandbox/modal/ModalT3Runtime.ts`

Modified files:

- Execution bridge materialization should delegate to `SandboxRuntime`.
- Server runtime startup should include the Sandbox layers.
- Project setup script runner can be reused for local setup and Snapshot setup where appropriate.
- Observability metrics should gain Sandbox lifecycle counters/timers.

### Orchestrator Schema

Modify Convex schema to store Sandbox references at Task/Work Session level:

- Add `sandboxProvider`: `"local" | "modal"` to Project configuration.
- Add Project-level Modal config fields:
  - `modalAppName`
  - `modalEnvironment`
  - `modalImageTag`
  - optional resource defaults
  - optional snapshot policy
  - optional service requirements
- Add Work Session fields:
  - `sandboxId`
  - `sandboxProviderKind`
  - `sandboxExternalId`
  - `sandboxStatus`
  - optional `sandboxFailureSummary`
  - optional `sandboxEnvironmentId`
  - optional `sandboxConnectUrl`
- Add Task event kinds:
  - `sandbox.materialization-requested`
  - `sandbox.provisioning`
  - `sandbox.ready`
  - `sandbox.failed`
  - `sandbox.archived`

The Orchestrator should store descriptors leanly. Full runtime state stays in T3 and Modal.

## Modal TypeScript Interfaces To Use

Use the published `modal` npm package, currently `modal@0.7.4`, as the TypeScript SDK surface.

Primary imports:

- `ModalClient`
- `ModalClientParams`
- `App`
- `AppFromNameParams`
- `Image`
- `ImageDockerfileCommandsParams`
- `Sandbox`
- `SandboxCreateParams`
- `SandboxExecParams`
- `SandboxListParams`
- `SandboxFromNameParams`
- `SandboxCreateConnectCredentials`
- `SandboxCreateConnectTokenParams`
- `SandboxFile`
- `SandboxFileMode`
- `Tunnel`
- `Secret`
- `SecretFromNameParams`
- `Volume`
- `VolumeFromNameParams`
- `Queue`
- `QueueFromNameParams`
- `Probe`
- `ProbeParams`
- `ContainerProcess`
- `TimeoutError`
- `SandboxTimeoutError`
- `NotFoundError`
- `AlreadyExistsError`
- `InvalidError`
- `RemoteError`
- `InternalFailure`
- `ClientClosedError`

Preferred Modal SDK calls:

- `new ModalClient({ tokenId, tokenSecret, environment, timeoutMs, maxRetries, logger })`
- `modal.apps.fromName(appName, { environment, createIfMissing: true })`
- `modal.images.fromRegistry(imageTag, registrySecret?)`
- `image.dockerfileCommands(commands, { env, secrets, forceBuild })`
- `image.build(app)` for Snapshot/image preparation when needed.
- `modal.secrets.fromName(name, { environment, requiredKeys })`
- `modal.secrets.fromObject(entries, { environment })` only for ephemeral/task-scoped generated secrets.
- `modal.volumes.fromName(name, { environment, createIfMissing })` only if the implementation chooses Modal Volumes for artifacts/cache.
- `modal.queues.fromName(name, { environment, createIfMissing })` only for provider-side command/event queues if needed after the first tracer bullet.
- `modal.sandboxes.create(app, image, SandboxCreateParams)`
- `modal.sandboxes.fromId(sandboxId)`
- `modal.sandboxes.fromName(appName, sandboxName, { environment })`
- `modal.sandboxes.list({ appId, tags, environment })`
- `sandbox.setTags(tags)` and `sandbox.getTags()`
- `sandbox.exec(command, SandboxExecParams)`
- `sandbox.open(path, mode)` for artifact reads/writes where practical.
- `sandbox.createConnectToken({ userMetadata })`
- `sandbox.tunnels(timeoutMs)`
- `sandbox.waitUntilReady(timeoutMs)`
- `sandbox.snapshotFilesystem(timeoutMs)`
- `sandbox.snapshotDirectory(path)`
- `sandbox.mountImage(path, image)`
- `sandbox.terminate({ wait: true })` for cleanup with exit code.
- `sandbox.detach()` only when intentionally leaving a Sandbox running after local resources are released.
- `sandbox.poll()` and `sandbox.wait()` for lifecycle checks.

`SandboxCreateParams` mapping:

- `name`: generated stable Task Sandbox name.
- `command`: T3 runtime bootstrap command.
- `workdir`: runtime work directory.
- `env`: non-secret environment variables.
- `secrets`: Modal `Secret[]` selected from Project config.
- `cpu`, `cpuLimit`, `memoryMiB`, `memoryLimitMiB`, `gpu`, `regions`: Project/resource config.
- `timeoutMs`, `idleTimeoutMs`: Project/resource config with safe defaults.
- `encryptedPorts`: T3 runtime HTTP/WebSocket/dev-server ports.
- `readinessProbe`: `Probe.withTcp(port)` or `Probe.withExec(argv)` for T3 runtime readiness.
- `volumes`: optional artifact/cache volumes.
- `includeOidcIdentityToken`: only if needed for provider-side cloud auth.

Avoid deprecated Modal APIs in new code:

- Do not use `App.lookup`; use `modal.apps.fromName`.
- Do not use `App#createSandbox`; use `modal.sandboxes.create`.
- Do not use `Image.fromRegistry`; use `modal.images.fromRegistry`.
- Do not use `Sandbox.fromId` or `Sandbox.fromName`; use `modal.sandboxes.fromId/fromName`.

## Phase 1: Contracts and Package Skeleton

**Blocked by**: None

**User stories**: 6, 8, 9, 15, 16, 19, 74, 75, 77, 79, 80, 81, 82, 99, 100

**What to build**

Create the provider-neutral contract and package shape without changing runtime behavior. The result should compile, expose schemas, and let tests exercise lifecycle/name/error helpers without Modal.

**Acceptance criteria**

- [x] Sandbox contract schemas exist and are exported from contracts.
- [x] Execution bridge contracts accept and return Sandbox descriptors while preserving compatibility fields.
- [x] `packages/sandbox` exists as a workspace package with package exports.
- [x] Provider-neutral `SandboxProvider` and fake provider interfaces exist.
- [x] Lifecycle, naming, Snapshot, service readiness, and retry helpers exist with focused tests.
- [x] No Modal SDK import exists in `packages/sandbox`.
- [x] `bun fmt`, `bun lint`, `bun typecheck`, and focused contract/package tests pass.

**References**

- `packages/contracts/src/executionBridge.ts`
- `packages/contracts/src/environment.ts`
- `packages/shared/package.json`
- `packages/shared/src/git.ts`
- `.plans/modal-sandbox-runtime/prd.md`

**Implementation Notes**

- Added schema-only Sandbox descriptors and execution bridge extensions. `TaskRuntimeMaterializeResponse` keeps `sandbox`, `environment`, and `services` optional in Phase 1 so existing local runtime responses continue to decode until Phase 2 routes materialization through the Sandbox runtime.
- Added `packages/sandbox` as a provider-neutral deep module with pure helpers and a deterministic fake provider only; no Modal SDK or server runtime wiring was introduced.
- Refreshed `bun.lock` with `bun install` so the new workspace package participates in package resolution.
- Follow-up review tightened generated Sandbox Service IDs so they are stable by service kind instead of overall request order.
- Follow-up review branded `sandboxId` in reconnect/archive/status bridge requests and added optional `projectKey` to the materialization Project payload.
- `bun fmt`, `bun lint`, `bun typecheck`, and focused contract/package tests pass.

**Implementation Footprint**

- Modified `bun.lock`.
- Modified `packages/contracts/src/executionBridge.ts`.
- Modified `packages/contracts/src/index.ts`.
- Added `packages/contracts/src/sandbox.ts`.
- Added `packages/contracts/src/sandbox.test.ts`.
- Added `packages/contracts/src/executionBridge.test.ts`.
- Added `packages/sandbox/package.json`.
- Added `packages/sandbox/tsconfig.json`.
- Added `packages/sandbox/src/index.ts`.
- Added `packages/sandbox/src/Provider.ts` and `packages/sandbox/src/Provider.test.ts`.
- Added `packages/sandbox/src/Errors.ts` and `packages/sandbox/src/Errors.test.ts`.
- Added `packages/sandbox/src/Lifecycle.ts` and `packages/sandbox/src/Lifecycle.test.ts`.
- Added `packages/sandbox/src/Names.ts` and `packages/sandbox/src/Names.test.ts`.
- Added `packages/sandbox/src/Snapshots.ts` and `packages/sandbox/src/Snapshots.test.ts`.
- Added `packages/sandbox/src/Services.ts` and `packages/sandbox/src/Services.test.ts`.
- Added `packages/sandbox/src/FakeSandboxProvider.ts` and `packages/sandbox/src/FakeSandboxProvider.test.ts`.

## Phase 2: Local Adapter Tracer Bullet

**Blocked by**: Phase 1

**User stories**: 4, 5, 10, 15, 36, 37, 39, 42, 45, 54, 55, 56, 63, 77, 82, 100

**What to build**

Refactor existing Task runtime materialization through the Sandbox runtime using a Local Sandbox adapter. This phase should preserve current behavior: create or find T3 Project, create git Worktree, create Thread, optionally start the Coding Agent, and track Work Session lifecycle.

**Acceptance criteria**

- [x] Existing Task materialization delegates to `SandboxRuntime.materializeTaskRuntime`.
- [x] Local Sandbox adapter creates the same Worktree and Thread shape as the current implementation.
- [x] Materialization response includes a `SandboxDescriptor` with `providerKind: "local"`.
- [x] Idempotency prevents duplicate Worktrees/Threads for repeated materialization requests with the same key.
- [x] Existing execution bridge and Orchestrator materialization tests are updated for Sandbox descriptors.
- [x] No Workspace behavior regresses for local Threads.
- [x] `bun fmt`, `bun lint`, `bun typecheck`, and focused execution bridge tests pass.

**References**

- `apps/server/src/executionBridge/runStart.ts`
- `apps/server/src/executionBridge/http.ts`
- `apps/server/src/vcs/GitVcsDriver.ts`
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts`
- `apps/orchestrator/convex/t3Runtime.ts`
- `apps/orchestrator/src/t3/client.ts`

**Implementation Notes**

- Added a server-side `SandboxRuntime` service and routed `executionBridge/runStart.materializeTaskRuntime` through it. The bridge wrapper still owns run lifecycle tracking, while `SandboxRuntimeLive` owns project lookup/creation, provider selection, Thread creation, optional first turn dispatch, and response shaping.
- Added a local `SandboxProvider` adapter that preserves the existing local behavior by creating a git Worktree from the Project default branch and returning local Sandbox, Environment, Worktree, and Service descriptors. The local adapter intentionally does not implement durable reconnect/archive/status yet; those become meaningful once Phase 3 persists Sandbox state.
- Added an in-memory idempotency guard keyed by `TaskRuntimeMaterializeRequest.idempotencyKey` or the derived `sandbox:<provider>:<task>:<workSession>` key. Duplicate requests in the same server process reuse the original Worktree, Thread, Sandbox descriptor, and response instead of dispatching duplicate commands.
- Updated the Orchestrator materialization action to request the local Sandbox provider, the required `t3-runtime` service, and the same stable idempotency key. Descriptor persistence and Task/Work Session state assertions remain part of Phase 3.
- Split shared execution bridge model-selection defaults into a small helper so run creation and Task Sandbox materialization share the same fallback behavior without a circular import.

**Implementation Footprint**

- Modified `bun.lock`.
- Modified `apps/orchestrator/convex/t3Runtime.ts`.
- Modified `apps/server/package.json`.
- Modified `apps/server/src/executionBridge/runStart.ts`.
- Added `apps/server/src/executionBridge/requestDefaults.ts`.
- Added `apps/server/src/executionBridge/runStart.materialize.test.ts`.
- Added `apps/server/src/sandbox/Services/SandboxRuntime.ts`.
- Added `apps/server/src/sandbox/Services/SandboxProviderRegistry.ts`.
- Added `apps/server/src/sandbox/Layers/SandboxRuntimeLive.ts`.
- Added `apps/server/src/sandbox/Layers/SandboxProviderRegistryLive.ts`.
- Added `apps/server/src/sandbox/Layers/LocalSandboxProvider.ts`.
- Modified `apps/server/src/server.ts`.
- Modified `apps/server/src/server.test.ts`.

## Phase 3: Persist Sandbox State And Runtime Endpoint

**Blocked by**: Phase 1

**User stories**: 15, 16, 18, 41, 42, 43, 44, 47, 50, 51, 66, 67, 68, 74, 76, 84, 85, 86, 87, 96, 97, 98

**What to build**

Extend Orchestrator schema and mutations so Task materialization stores the minimum Sandbox identity/status needed to route later operations to the correct Task runtime. This phase is now the required bridge between the local MVP and the Modal MVP.

The Orchestrator must persist enough of the returned `SandboxDescriptor` and `t3-runtime` service descriptor to answer: "for this Work Session, where is its T3 runtime right now?" That endpoint becomes the target for continuation, PR ensure, status, reconnect, and archive calls after materialization.

**Acceptance criteria**

- [x] Project configuration can select `sandboxProvider`.
- [x] Project configuration can store minimal Modal config: app name, environment, image tag, resource defaults, timeout defaults, and allowed secret names.
- [x] Work Sessions can store Sandbox identity, provider refs, lifecycle status, Environment refs, and failure summaries.
- [x] Work Sessions or related records can store the active `t3-runtime` service endpoint for runtime routing.
- [ ] Task events record materialization requested/provisioning/ready/failed/archived milestones.
- [x] Orchestrator materialization action records the Sandbox descriptor returned by T3.
- [x] Follow-up turn and PR ensure calls can resolve the active runtime endpoint from Work Session state instead of assuming global `T3_EXECUTION_BRIDGE_BASE_URL`.
- [ ] Lifecycle callback handling updates Work Session and Task state with Sandbox references.
- [x] Repeated materialization responses are idempotent.
- [x] `bun fmt`, `bun lint`, `bun typecheck`, and focused Orchestrator tests pass.

**References**

- `apps/orchestrator/convex/schema.ts`
- `apps/orchestrator/convex/t3Runtime.ts`
- `apps/orchestrator/convex/tasks.ts`
- `apps/orchestrator/convex/workSessions.ts`
- `apps/orchestrator/convex/taskEvents.ts`
- `apps/orchestrator/src/executionLifecycle.ts`

**Implementation Notes**

- Keep the persisted shape lean. Full Modal state stays behind the T3 Sandbox adapter; Convex only needs operational identity, status, failure summary, Worktree metadata, and connection endpoint descriptors.
- The existing global bridge URL is still acceptable for the initial allocation/control bridge. It is not acceptable for Work Session-specific follow-up and PR operations once Modal tasks exist.
- Treat missing runtime endpoint as a blocked/provisioning failure for Modal tasks, not as a fallback to local execution.
- Review tightened the Sandbox Service schema: `endpointUrl` remains for compatibility, but new code should prefer typed `endpoints[]` with explicit protocol, access mode, and auth metadata. Secret values are not stored in descriptors.
- Review tightened Sandbox resources to positive finite values and added provider config to runtime selection so Modal app/image/runtime/secret-name choices are first-class rather than hidden in metadata.
- Phase 3 implementation stores project-level Modal config and Work Session-level Sandbox identity/status/provider refs/service JSON/runtime endpoint. The denormalized `sandboxRuntimeEndpointUrl` is the routing source for follow-up turns and PR ensure.
- Runtime routing now fails for Modal sessions with no persisted endpoint. Only local/legacy sessions can fall back to the global control bridge.
- Materialization failures mark the Work Session and Task failed so a prepared Work Session does not remain stuck in `requested`.

**Implementation Footprint**

- Modified `packages/contracts/src/sandbox.ts`.
- Modified `packages/contracts/src/sandbox.test.ts`.
- Modified `packages/contracts/src/executionBridge.ts`.
- Modified `packages/contracts/src/executionBridge.test.ts`.
- Modified `apps/orchestrator/convex/schema.ts`.
- Modified `apps/orchestrator/convex/projects.ts`.
- Modified `apps/orchestrator/convex/workSessions.ts`.
- Modified `apps/orchestrator/convex/tasks.ts`.
- Modified `apps/orchestrator/convex/t3Runtime.ts`.
- Modified `apps/orchestrator/src/t3/client.ts`.
- Added `apps/orchestrator/src/t3/runtimeRouting.ts`.
- Added `apps/orchestrator/src/t3/runtimeRouting.test.ts`.
- Added `apps/orchestrator/src/t3/client.test.ts`.

## Phase 4: Modal Adapter Minimal Runtime

**Blocked by**: Phase 1, Phase 2

**User stories**: 1, 2, 3, 6, 7, 15, 16, 17, 18, 19, 20, 31, 36, 37, 38, 39, 43, 44, 60, 61, 62, 66, 67, 68, 69, 70, 71, 73, 74, 75, 76, 83, 88, 89, 90, 91, 92, 95

**What to build**

Implement the first Modal Cloud Sandbox adapter. It should create or reconnect a named Modal Sandbox, run the T3 runtime bootstrap command inside it, expose the T3 runtime port, wait for readiness, and return a Cloud Sandbox descriptor with a `t3-runtime` service endpoint. This phase does not need Snapshot acceleration, browser support, or Convex service provisioning.

This adapter should be tested with a fake Modal client first. The live Modal smoke is intentionally blocked on operator-provided environment variables and should not be attempted until requested.

**Acceptance criteria**

- [x] Modal SDK dependency is added only where the server adapter needs it.
- [x] `ModalClient` is constructed from server-side config and never from browser code.
- [x] Adapter uses `modal.apps.fromName`, `modal.images.fromRegistry`, and `modal.sandboxes.create`.
- [x] Adapter uses `SandboxCreateParams` for name, command, workdir, env, secrets, resources, ports, timeouts, and readiness probe.
- [x] Adapter can reconnect with `modal.sandboxes.fromName`.
- [x] Adapter tags Sandboxes with Project, Task, Work Session, provider, and environment metadata.
- [x] Adapter returns `SandboxDescriptor`, `ExecutionEnvironmentDescriptor`, service descriptor for `t3-runtime`, and connection metadata.
- [x] Adapter does not create the Task worktree on the Operator machine for Modal tasks.
- [x] Modal errors are normalized into stable Sandbox errors.
- [x] Unit tests use a fake Modal client and do not require Modal credentials.
- [x] Live Modal test is opt-in behind operator-provided Modal credentials and runtime config.
- [x] `bun fmt`, `bun lint`, `bun typecheck`, and focused Modal adapter tests pass.

**References**

- `modal@0.7.4` TypeScript exports: `ModalClient`, `App`, `Image`, `Sandbox`, `SandboxCreateParams`, `SandboxExecParams`, `Probe`, `Tunnel`, `Secret`, `TimeoutError`, `SandboxTimeoutError`, `NotFoundError`, `AlreadyExistsError`, `InvalidError`, `RemoteError`, `InternalFailure`
- [Modal Sandbox docs](https://modal.com/docs/guide/sandbox)
- [Modal Sandbox reference](https://modal.com/docs/reference/modal.Sandbox)
- `apps/server/src/environment/Layers/ServerEnvironment.ts`
- `apps/server/src/serverRuntimeStartup.ts`
- `apps/web/src/environments/remote/api.ts`
- `packages/client-runtime/src/knownEnvironment.ts`

**Implementation Notes**

- Minimum server-side env/config needed for the live smoke should be documented before asking the operator for values. Expected values likely include Modal token id/secret, Modal environment, app name, image tag, repo clone auth/secret names, T3 runtime port, and allowed resource defaults.
- Prefer one explicit bootstrap script/command for the Modal T3 runtime so local tests can assert command construction without requiring Modal.
- The first version can use clean clone/setup on every task. Snapshot acceleration is deferred.
- Added the `modal` JavaScript SDK only to `apps/server`; no browser package imports it.
- The live adapter uses `ModalClient`, `modal.apps.fromName({ createIfMissing: true })`, `modal.images.fromRegistry`, `modal.sandboxes.create`, `Probe.withTcp`, encrypted ports, Modal Secrets by configured names, tags, `waitUntilReady`, tunnels, and `detach`.
- The adapter uses a small `ModalSandboxClient` interface so unit tests exercise descriptor/endpoint/tag construction without Modal credentials.
- This reaches the live Modal Sandbox creation checkpoint. The next test requires operator-provided credentials and a runtime image/command that actually starts a T3 execution bridge in the Sandbox.
- Added a minimal Modal runtime image recipe at `apps/server/Dockerfile.modal-runtime`. The image builds the server bundle, keeps a copy of the repo at `/workspace/t3code`, and starts `node /app/apps/server/dist/bin.mjs serve` on `${T3_RUNTIME_PORT:-8787}` for the execution bridge.
- Docker Desktop could not publish the image locally during implementation because its containerd metadata store hit I/O errors after an oversized build context. Added `.dockerignore` so future Docker builds do not copy host `node_modules` or desktop artifacts.
- Added `SandboxRuntimeProviderConfig.imageDockerfileCommands` so the Modal adapter can build the first runtime image remotely through Modal. The live smoke used `node:24-bookworm-slim`, installed Bun and the Linux build toolchain, cloned `affil/mvp-deployment`, ran `bun install --frozen-lockfile`, ran `bun --filter t3 build:bundle`, and copied the repo to `/workspace/t3code`.
- Live Modal runtime smoke passed: the Sandbox booted the real T3 server, returned a `t3-runtime` tunnel, and an authenticated `/api/execution/runs/status` request returned `found: false` for a deliberately missing run.

**Implementation Footprint**

- Modified `bun.lock`.
- Added `.dockerignore`.
- Modified `apps/server/package.json`.
- Added `apps/server/Dockerfile.modal-runtime`.
- Modified `packages/contracts/src/sandbox.ts`.
- Modified `packages/contracts/src/sandbox.test.ts`.
- Modified `packages/sandbox/src/Provider.ts`.
- Modified `apps/server/src/sandbox/Layers/SandboxRuntimeLive.ts`.
- Modified `apps/server/src/sandbox/Layers/SandboxProviderRegistryLive.ts`.
- Added `apps/server/src/sandbox/Layers/ModalSandboxProvider.ts`.
- Added `apps/server/src/sandbox/Layers/ModalSandboxProvider.test.ts`.

## Phase 5: Remote T3 Handshake And PR Routing

**Blocked by**: Phase 4

**User stories**: 4, 5, 24, 26, 36, 37, 38, 39, 45, 46, 54, 55, 56, 57, 63, 64, 65, 67, 83, 84

**What to build**

Make the Modal Sandbox do real Task work. The control bridge should allocate/reconnect the Modal Sandbox, but the T3 runtime inside Modal should create the Task Worktree Branch, create the Primary Thread, start the Coding Agent, and run PR orchestration against the Cloud Worktree.

This phase is the heart of the MVP. It reconciles the current local behavior with the desired product behavior: the Operator machine may coordinate, but it must not be the machine doing the task execution for Modal tasks.

**Acceptance criteria**

- [ ] Modal materialization prepares a Cloud Worktree inside the Sandbox.
- [ ] Branch naming uses the shared Sandbox naming helper.
- [ ] T3 runtime inside Modal reports a stable Environment descriptor.
- [ ] Materialization can call into the Modal T3 runtime and receive the remote `t3ProjectId`, `t3ThreadId`, branch, worktree path, Sandbox descriptor, and services.
- [ ] Primary Thread creation and first turn start inside the Cloud Sandbox, not the Operator machine.
- [ ] Follow-up messages use the Work Session runtime endpoint and continue the same Modal T3 Thread.
- [ ] PR ensure uses the Work Session runtime endpoint and creates the draft PR from the Cloud Worktree.
- [ ] Validation commands/project scripts run inside the Cloud Sandbox.
- [ ] Restart can reconnect to an existing healthy Cloud Sandbox.
- [ ] Slack completion reply includes the PR created from the Modal task branch.
- [ ] Unhealthy Sandbox replacement is documented as follow-up unless needed for the live MVP smoke.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and focused remote Environment/materialization tests pass.

**References**

- `apps/server/src/environment/*`
- `apps/web/src/environments/runtime/*`
- `apps/web/src/environmentApi.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/provider/Services/ProviderService.ts`
- `apps/server/src/project/Layers/ProjectSetupScriptRunner.ts`

**Implementation Notes**

- The simplest shape is a control-plane T3 endpoint that asks Modal for a running Sandbox, then forwards an internal materialization request to the T3 server inside Modal. Avoid duplicating Thread/worktree creation logic in the Modal adapter if the remote T3 runtime can perform it through the same existing bridge contract.
- PR routing must be tested explicitly. A passing Coding Agent completion is not enough if PR ensure still calls the local bridge.
- The Slack E2E from the previous MVP is the regression template: tiny file change, draft PR, Convex `github_pr` link, Slack completion reply with PR URL.

**Implementation Footprint**

## Phase 6: Slack Modal E2E And Cleanup Guardrails

**Blocked by**: Phase 5

**User stories**: 1, 2, 15, 39, 41, 43, 50, 51, 57, 69, 72, 73, 83, 86, 87, 95

**What to build**

Run the first live Slack-to-Modal-to-PR tracer bullet and add only the cleanup guardrails required to keep the MVP safe. This phase is where implementation should pause and ask the operator for Modal environment variables and credentials before attempting the live Modal smoke.

**Acceptance criteria**

- [ ] Required Modal env vars and secret names are documented before live testing.
- [ ] Live test only runs after the operator provides/approves Modal env vars.
- [ ] Slack `#testing` task creates a Modal-backed Work Session.
- [ ] Modal dashboard/provider state shows exactly one named Sandbox for the test Work Session.
- [ ] The requested file change is made inside the Modal Cloud Worktree.
- [ ] Draft PR is created from the Modal task branch.
- [ ] Convex stores the `github_pr` link and Sandbox references.
- [ ] Slack receives one completion reply with the PR URL.
- [ ] Modal Sandbox has conservative timeout/idle timeout configured.
- [ ] A manual terminate/archive path exists or is documented with exact command/operator steps for the MVP.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and focused tests pass after live validation notes are recorded.

**References**

- Slack `#testing`
- `apps/orchestrator/convex/t3Runtime.ts`
- `apps/orchestrator/convex/taskEvents.ts`
- `apps/orchestrator/convex/taskExternalLinks.ts`
- `apps/server/src/sandbox/modal/*`
- `apps/server/src/executionBridge/runStart.ts`
- `apps/server/src/sourceControl/GitHubCli.ts`

**Implementation Notes**

- Do not leave Convex pointing at a local tunnel or stale Modal runtime endpoint after testing.
- Keep the first live Modal task tiny and deterministic, matching the prior Slack PR orchestration E2E pattern.
- Stop before the live Modal smoke and ask the operator for Modal credentials/config values. Do not invent placeholder credentials or run cloud allocation without explicit values.

**Implementation Footprint**

## Phase 7: Deferred Sandbox Platform Backlog

**Blocked by**: Phase 6

**User stories**: 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 40, 48, 49, 63, 64, 65, 73, 83, 85, 88, 89, 92, 93, 94, 95

**What to build**

After the Modal tracer bullet works, expand the Sandbox platform: Snapshots, task-scoped Convex deployment, browser/dev-server services, artifact archival, metrics, cleanup jobs, and richer Workspace visibility. These are important, but they should not block the first Modal-backed Slack Task MVP.

**Acceptance criteria**

- [ ] Project config can declare Snapshot policy and setup commands.
- [ ] Snapshot creation records source branch, commit, created time, setup outcome, image id, and failure details.
- [ ] Modal adapter can use `sandbox.snapshotFilesystem`, `sandbox.snapshotDirectory`, `sandbox.mountImage`, `Image#dockerfileCommands`, and `Image#build` where appropriate.
- [ ] Materialization selects the latest healthy non-stale Snapshot with clean setup fallback.
- [ ] Sandbox Service request/descriptor flow supports `convex`, `dev-server`, `browser`, `terminal`, and `custom`.
- [ ] Project config can request Convex as a required Sandbox Service.
- [ ] Modal adapter provisions Convex inside the Cloud Sandbox with Project-approved secrets.
- [ ] Convex service descriptor reports status, endpoint, health, and failure details.
- [ ] Browser service can appear as `requested` or `deferred` descriptor without functional browser support.
- [ ] Primary Thread starts after required services are ready.
- [ ] Optional service failures do not block safe investigation work.
- [ ] Snapshot age, startup latency, active sandbox count, and cleanup metrics are emitted.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and focused Snapshot/Sandbox Service tests pass.

**References**

- `apps/orchestrator/convex/projects.ts`
- `apps/server/src/project/Layers/ProjectSetupScriptRunner.ts`
- [Modal Snapshot docs](https://modal.com/docs/guide/sandbox-memory-snapshots)
- `modal@0.7.4` TypeScript exports: `Sandbox#snapshotFilesystem`, `Sandbox#snapshotDirectory`, `Sandbox#mountImage`, `Image`, `ImageDockerfileCommandsParams`
- `modal@0.7.4` TypeScript exports: `Secret`, `SecretService`, `SandboxExecParams`, `ContainerProcess`
- Convex CLI/project docs as needed during implementation.

**Implementation Notes**

**Implementation Footprint**

## Phase 8: Workspace Sandbox Visibility

**Blocked by**: Phase 3, Phase 5

**User stories**: 37, 38, 41, 50, 51, 52, 53, 60, 61, 62, 67, 86, 87, 95, 99, 100

**What to build**

Expose Sandbox state in the Workspace and Team App narrative without adding noisy updates. Operators should see Sandbox Provider, lifecycle status, Worktree Branch, service health, relevant endpoints, and connection state.

**Acceptance criteria**

- [ ] Task tree or Task details show Sandbox Provider and lifecycle status.
- [ ] Task details show Worktree Branch and service health.
- [ ] Cloud Sandbox Environment links route to the active Primary Thread.
- [ ] Failure summaries are visible and actionable.
- [ ] Linear acknowledgements include Workspace/Task links once materialization is accepted.
- [ ] Routine Team App updates stay meaningful and non-periodic.
- [ ] Browser service appears as deferred rather than broken.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and focused Workspace/Orchestrator tests pass.

**References**

- `apps/web/src/store.ts`
- `apps/web/src/environmentApi.ts`
- `apps/web/src/environments/runtime/*`
- `apps/orchestrator/convex/tasks.ts`
- `apps/orchestrator/convex/t3Runtime.ts`
- `.plans/ai-engineer-task-orchestrator/plan.md`

**Implementation Notes**

**Implementation Footprint**

## Phase 9: Cleanup, Archival, and Cost Controls

**Blocked by**: Phase 4, Phase 5

**User stories**: 47, 48, 49, 66, 69, 70, 71, 72, 73, 88, 89, 90, 91, 96, 97, 98

**What to build**

Add resource controls for Cloud Sandboxes: concurrency limits, queueing, idle timeout policy, archival, artifact capture, termination, and leaked Sandbox cleanup.

**Acceptance criteria**

- [ ] Organization/Project concurrency limits are enforced before Modal allocation.
- [ ] Capacity exhaustion puts Tasks into an explicit queued/provisioning state.
- [ ] Canceled Tasks archive artifacts and terminate or detach the Cloud Sandbox.
- [ ] Completed Tasks archive artifacts before release.
- [ ] Cleanup can find leaked Modal Sandboxes by tags and persisted state.
- [ ] `sandbox.terminate({ wait: true })` is used where exit code matters.
- [ ] `sandbox.detach()` is used only when intentionally leaving a Sandbox running.
- [ ] Metrics cover active count, allocation latency, startup latency, failure count, Snapshot age, and cleanup outcomes.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and focused cleanup tests pass.

**References**

- `modal@0.7.4` TypeScript exports: `Sandbox#terminate`, `Sandbox#detach`, `Sandbox#poll`, `Sandbox#wait`, `SandboxService#list`, `SandboxListParams`
- `apps/server/src/observability/Metrics.ts`
- `apps/orchestrator/convex/workSessions.ts`
- `apps/orchestrator/convex/taskEvents.ts`

**Implementation Notes**

**Implementation Footprint**

## Phase 10: Email Intake Integration

**Blocked by**: Phase 5, Phase 7

**User stories**: 11, 12, 13, 14, 52, 53, 84, 85, 86, 87

**What to build**

Wire `help@nextcard.com` intake into the same Task materialization path. This phase should not create a separate runtime implementation; it should create/link Linear issue, create Task, request Modal Cloud Sandbox materialization, provision Convex service, and start the Primary Thread.

**Acceptance criteria**

- [ ] Email intake can create or link a Linear issue for actionable bug reports.
- [ ] Email-created Tasks use the same Project resolution and Task materialization path as Linear/Workspace Tasks.
- [ ] Initial Primary Thread prompt includes bug report, Linear link, Project context, and Sandbox details.
- [ ] Acknowledgements explain provisioning/investigating status without exposing raw Modal internals.
- [ ] Duplicate email/webhook retries do not duplicate Tasks or Sandboxes.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and focused intake tests pass.

**References**

- `apps/orchestrator/src/linear/ingress.ts`
- `apps/orchestrator/convex/linear.ts`
- `apps/orchestrator/convex/tasks.ts`
- `apps/orchestrator/convex/t3Runtime.ts`
- Gmail or email connector/server code chosen during implementation.

**Implementation Notes**

**Implementation Footprint**

## Verification

Run these before considering the plan complete:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- Focused tests for touched packages/modules with `bun run test`, never `bun test`.
- Opt-in Modal live smoke only when credentials are intentionally provided.

## MVP Modal Secrets Checkpoint

Task sandboxes use named Modal Secrets only; Convex Project configuration stores secret names in
`modalAllowedSecretNamesJson`, not raw credential values. The runtime expects these secret-backed
environment variables:

- Git/GitHub auth: `GH_TOKEN` or `GITHUB_TOKEN`; optional `T3_GH_HOSTS_YML_B64`.
- Codex subscription auth: `T3_CODEX_AUTH_JSON_B64`; optional `T3_CODEX_CONFIG_TOML_B64`.
- OpenCode Bedrock auth/config: `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION` or
  `AWS_DEFAULT_REGION`, `T3_OPENCODE_MODEL`, and optional `OPENCODE_CONFIG_CONTENT` or
  `T3_OPENCODE_CONFIG_JSON_B64`. Standard AWS keys remain supported when needed.
- Execution bridge auth: `T3_EXECUTION_BRIDGE_SHARED_SECRET`.

The Modal runtime entrypoint decodes the base64 file-backed values into `$CODEX_HOME`, GitHub CLI
config, and `OPENCODE_CONFIG_CONTENT` before starting the T3 server. `GH_TOKEN` is also wired into a
Git credential helper so `git push` and `gh pr create` both use the same secret. When
`T3_OPENCODE_MODEL` is present, the entrypoint writes first-boot T3 settings that make OpenCode the
default provider for coding turns and PR text generation.

Recommended MVP secret names:

```json
[
  "t3-git-auth",
  "t3-codex-subscription",
  "t3-opencode-bedrock",
  "t3-execution-bridge"
]
```

Project setup should set:

```json
{
  "sandboxProvider": "modal",
  "modalAllowedSecretNamesJson": "[\"t3-git-auth\",\"t3-codex-subscription\",\"t3-opencode-bedrock\",\"t3-execution-bridge\"]"
}
```

The Modal TypeScript SDK can reference named secrets and create ephemeral secrets, but it does not
expose a named-secret update API in `modal@0.7.4`. Create/update the named Modal Secrets out of band
with the Modal CLI or dashboard, then let T3 attach them by name during Sandbox creation.

## MVP Credential-Free Test Gate

Before requesting Modal environment variables, the implementation should pass this focused set:

```sh
cd /Users/vivek/Affil/t3code/packages/sandbox
bun run test

cd /Users/vivek/Affil/t3code/packages/contracts
bun run test -- src/sandbox.test.ts src/executionBridge.test.ts

cd /Users/vivek/Affil/t3code/apps/server
bun run test -- src/executionBridge/runStart.materialize.test.ts src/executionBridge/http.test.ts

cd /Users/vivek/Affil/t3code/apps/orchestrator
bun run test -- src/executionLifecycle.test.ts src/domain/taskStatus.test.ts
```

Add these before the live Modal smoke:

- Modal provider unit tests using a fake Modal client for create/reconnect/error mapping.
- Server registry tests proving `providerKind: "modal"` resolves to the Modal adapter when configured.
- Runtime routing tests proving follow-up turns and PR ensure use the Work Session `t3-runtime` endpoint for Modal tasks.
- A materialization test proving Modal allocation does not create a local task worktree or local task turn.

## Done Criteria

- The Task materialization contract includes Sandbox descriptors and remains backward-compatible where required.
- `packages/sandbox` is the deep provider-neutral module for lifecycle, naming, Snapshot selection, services, and errors.
- Local materialization works through the Sandbox interface.
- Modal materialization can allocate/reconnect a Cloud Sandbox, start T3 runtime, and return an Environment descriptor.
- Cloud Worktree work happens inside the Modal Sandbox.
- Task-scoped Convex Sandbox Service provisioning exists.
- Workspace and Orchestrator can display and persist Sandbox lifecycle state.
- Cleanup, archival, idempotency, and concurrency controls are in place.
- Email intake can use the same materialization path for `help@nextcard.com` bug Tasks.
