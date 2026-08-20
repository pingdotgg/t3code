# Kimi Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kimi Code CLI as a fully integrated Early Access provider across T3 Code's server, web, desktop, and mobile surfaces using the official `kimi acp` protocol.

**Architecture:** A dedicated `kimi` driver owns Kimi configuration, status, ACP sessions, and auxiliary text generation while reusing T3's shared ACP transport and canonical event helpers. Small opt-in ACP runtime extensions add resume-first continuation and available-command state without changing Cursor or Grok behavior. Clients remain provider-generic apart from presentation metadata and icons.

**Tech Stack:** TypeScript, Effect, Effect Schema, `effect-acp`, Vitest through `vp test run`, React/Vite, React Native, Astro documentation/marketing.

## Global Constraints

- Use driver kind `kimi`, default instance ID `kimi`, product label `Kimi`, and diagnostic label `Kimi Code CLI`.
- Launch only the official ACP transport: `<binary> <tokenized launchArgs> acp`.
- `KimiSettings.enabled` defaults to `false`; Kimi carries `badgeLabel: "Early Access"`.
- Negotiate capabilities from ACP responses; do not invent model slugs, option values, or supported input types.
- Keep Cursor and Grok behavior unchanged; shared ACP additions must be opt-in or backward compatible.
- Reuse T3's existing per-thread MCP bridge. Do not add a new global MCP configuration product.
- Preserve provider-instance isolation and remote operation: all Kimi processes run on the T3 server.
- Add no new runtime dependency unless an existing repository utility cannot satisfy a required behavior.
- Follow red-green-refactor for every production behavior and run only focused tests/type checks.
- Do not launch browsers, simulators, or other computer-use verification without explicit user approval.

---

### Task 1: Contract, settings, and provider naming

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/settings.test.ts`
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/model.test.ts`
- Modify: `apps/server/src/textGeneration/TextGeneration.ts`

**Interfaces:**

- Produces: `KimiSettings` with `{ enabled, binaryPath, homePath, launchArgs, customModels }`.
- Produces: legacy `ServerSettings.providers.kimi` and `ServerSettingsPatch.providers.kimi` compatibility fields.
- Produces: `PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("kimi")] === "Kimi"`.
- Preserves: no hard-coded Kimi default model; live ACP discovery supplies the default.

- [ ] **Step 1: Write failing contract tests for Kimi defaults and patch decoding**

Add assertions equivalent to:

```ts
const settings = Schema.decodeSync(ServerSettings)({ providers: { kimi: {} } });
expect(settings.providers.kimi).toEqual({
  enabled: false,
  binaryPath: "kimi",
  homePath: "",
  launchArgs: "",
  customModels: [],
});

const patch = Schema.decodeSync(ServerSettingsPatch)({
  providers: { kimi: { homePath: " ~/.kimi-work ", launchArgs: " --agent coder " } },
});
expect(patch.providers?.kimi).toEqual({
  homePath: "~/.kimi-work",
  launchArgs: "--agent coder",
});
```

Add a model test asserting `PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("kimi")]` is `Kimi` and that normalizing an unknown Kimi model preserves its discovered slug.

- [ ] **Step 2: Run the contract tests and verify the expected failures**

Run:

```text
vp test run packages/contracts/src/settings.test.ts packages/contracts/src/model.test.ts
```

Expected: failures because `KimiSettings`, `providers.kimi`, and the Kimi display name do not exist.

- [ ] **Step 3: Add `KimiSettings` and wire both full and patch schemas**

Add the schema in the built-in provider order before OpenCode:

```ts
export const KimiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("kimi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Kimi Code CLI binary used by this instance.",
        providerSettingsForm: { placeholder: "kimi", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "KIMI_CODE_HOME path",
        description: "Custom Kimi Code home, configuration, credentials, and sessions directory.",
        providerSettingsForm: { placeholder: "~/.kimi-code", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional global CLI arguments passed before kimi acp on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["binaryPath", "homePath", "launchArgs"] },
);
export type KimiSettings = typeof KimiSettings.Type;
```

Add `kimi` to `ServerSettings.providers`, define `KimiSettingsPatch`, and add it to `ServerSettingsPatch.providers`.

- [ ] **Step 4: Add Kimi to shared display metadata and text-generation provider typing**

Add:

```ts
const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");

export const PROVIDER_DISPLAY_NAMES = {
  // existing entries
  [KIMI_DRIVER_KIND]: "Kimi",
} satisfies Partial<Record<ProviderDriverKind, string>>;
```

Extend `TextGenerationProvider` with `"kimi"`. Do not add Kimi to `DEFAULT_MODEL_BY_PROVIDER` or `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`; provider snapshots mark the ACP current model as default.

- [ ] **Step 5: Run focused tests and commit**

Run:

```text
vp test run packages/contracts/src/settings.test.ts packages/contracts/src/model.test.ts
```

Expected: all selected tests pass.

Commit:

```text
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts packages/contracts/src/model.ts packages/contracts/src/model.test.ts apps/server/src/textGeneration/TextGeneration.ts
git commit -m "feat(contracts): add Kimi provider settings"
```

### Task 2: Kimi home, process environment, skills, and ACP launch

**Files:**

- Create: `apps/server/src/provider/Drivers/KimiHome.ts`
- Create: `apps/server/src/provider/Drivers/KimiHome.test.ts`
- Create: `apps/server/src/provider/Drivers/KimiSkills.ts`
- Create: `apps/server/src/provider/Drivers/KimiSkills.test.ts`
- Create: `apps/server/src/provider/acp/KimiAcpSupport.ts`
- Create: `apps/server/src/provider/acp/KimiAcpSupport.test.ts`

**Interfaces:**

- Produces: `resolveKimiHomePath(config): Effect<string, never, Path.Path>`.
- Produces: `makeKimiEnvironment(config, baseEnv): Effect<NodeJS.ProcessEnv, never, Path.Path>`.
- Produces: `makeKimiContinuationGroupKey(config): Effect<string, never, Path.Path>`.
- Produces: `discoverKimiSkills(config, cwd, environment?): Effect<ReadonlyArray<ServerProviderSkill>, never, FileSystem | Path>`.
- Produces: `buildKimiAcpSpawnInput(settings, cwd, environment): AcpSpawnInput`.
- Produces: `makeKimiAcpRuntime(input)` and `applyKimiAcpModelSelection(input)`.

- [ ] **Step 1: Write failing home/environment tests**

Test empty and explicit homes:

```ts
expect(yield * resolveKimiHomePath({ homePath: "" })).toBe(
  path.resolve(NodeOS.homedir(), ".kimi-code"),
);
expect(yield * resolveKimiHomePath({ homePath: "~/.kimi-work" })).toBe(
  path.resolve(NodeOS.homedir(), ".kimi-work"),
);
expect(
  (yield * makeKimiEnvironment({ homePath: "~/.kimi-work" }, { PATH: "bin" })).KIMI_CODE_HOME,
).toBe(path.resolve(NodeOS.homedir(), ".kimi-work"));
expect(yield * makeKimiContinuationGroupKey({ homePath: "~/.kimi-work" })).toBe(
  `kimi:home:${path.resolve(NodeOS.homedir(), ".kimi-work")}`,
);
```

- [ ] **Step 2: Run the home tests to verify they fail, then implement the helpers**

Run `vp test run apps/server/src/provider/Drivers/KimiHome.test.ts`.

Implement with `expandHomePath`, `node:os.homedir`, and `Path.resolve`. `makeKimiEnvironment` must preserve the supplied base environment and set an absolute `KIMI_CODE_HOME` only when `homePath` is non-empty; the resolved default is used for discovery and continuation identity, not forced into every child environment.

- [ ] **Step 3: Write failing ACP spawn/model tests**

Cover binary, argument order, env, auth method, and option ordering:

```ts
expect(
  buildKimiAcpSpawnInput(
    { binaryPath: "/opt/kimi", launchArgs: "--agent coder --skills-dir 'team skills'" },
    "/repo",
    { KIMI_CODE_HOME: "/homes/work" },
  ),
).toEqual({
  command: "/opt/kimi",
  args: ["--agent", "coder", "--skills-dir", "team skills", "acp"],
  cwd: "/repo",
  env: { KIMI_CODE_HOME: "/homes/work" },
});
```

Use a fake runtime to assert `applyKimiAcpModelSelection` calls `setModel` first and then only applies stored option selections that still exist in `getConfigOptions`.

- [ ] **Step 4: Implement Kimi ACP support**

Use `tokenizeCliArgs` from `@t3tools/shared/cliArgs` and configure the shared runtime with:

```ts
AcpSessionRuntime.layer({
  ...input,
  spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
  authMethodId: "login",
  resumeStrategy: "resume-first",
});
```

`applyKimiAcpModelSelection` calls `runtime.setModel(model)` when a non-empty model is requested, reloads `runtime.getConfigOptions`, and calls `setConfigOption(id, value)` only for exact advertised IDs and compatible value types.

- [ ] **Step 5: Write failing Kimi skill discovery tests**

Create temporary user/project trees and assert priority:

```text
<home>/skills/review/SKILL.md
<os-home>/.agents/skills/shared/SKILL.md
<cwd>/.kimi-code/skills/review/SKILL.md
<cwd>/.agents/skills/project/SKILL.md
```

Expect project `review` to replace user `review`, valid frontmatter to populate name/display/description, unreadable or malformed entries to be skipped, and results to be sorted by name.

- [ ] **Step 6: Implement skill discovery and run the slice**

Parse the same minimal frontmatter fields used by `ClaudeSkills.ts`. Scan configured Kimi home, OS-level `.agents/skills`, and both project directories. Only include a directory containing `SKILL.md`; never follow a discovered path outside its configured root.

Run:

```text
vp test run apps/server/src/provider/Drivers/KimiHome.test.ts apps/server/src/provider/Drivers/KimiSkills.test.ts apps/server/src/provider/acp/KimiAcpSupport.test.ts
```

Commit:

```text
git add apps/server/src/provider/Drivers/KimiHome.ts apps/server/src/provider/Drivers/KimiHome.test.ts apps/server/src/provider/Drivers/KimiSkills.ts apps/server/src/provider/Drivers/KimiSkills.test.ts apps/server/src/provider/acp/KimiAcpSupport.ts apps/server/src/provider/acp/KimiAcpSupport.test.ts
git commit -m "feat(server): add Kimi ACP launch support"
```

### Task 3: Shared ACP resume and available-command state

**Files:**

- Modify: `apps/server/src/provider/acp/AcpRuntimeModel.ts`
- Modify: `apps/server/src/provider/acp/AcpRuntimeModel.test.ts`
- Modify: `apps/server/src/provider/acp/AcpSessionRuntime.ts`
- Modify: `apps/server/src/provider/acp/AcpSessionRuntime.test.ts`

**Interfaces:**

- Produces: `AcpParsedSessionEvent` variant `{ _tag: "AvailableCommandsChanged"; commands }`.
- Produces: `AcpSessionRuntime.getAvailableCommands`.
- Produces: optional `AcpSessionRuntimeOptions.resumeStrategy: "load" | "resume-first"`, defaulting to `"load"`.
- Preserves: existing Cursor/Grok startup behavior and tests.

- [ ] **Step 1: Write a failing parser test for `available_commands_update`**

Use the generated ACP shape:

```ts
const parsed = parseSessionUpdateEvent({
  sessionId: "session-1",
  update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "skill:review", description: "Review the current change", input: { hint: "scope" } },
    ],
  },
});
expect(parsed.events).toEqual([
  {
    _tag: "AvailableCommandsChanged",
    commands: [
      { name: "skill:review", description: "Review the current change", input: { hint: "scope" } },
    ],
  },
]);
```

- [ ] **Step 2: Implement parsing and retained command state**

Add the event variant, parse trimmed non-empty commands, and maintain a `Ref<ReadonlyArray<AvailableCommand>>` in `AcpSessionRuntime`. When event ingestion sees `AvailableCommandsChanged`, replace the ref and still enqueue the event. Expose `getAvailableCommands: Ref.get(availableCommandsRef)`.

- [ ] **Step 3: Write failing resume-first runtime tests**

Extend the ACP mock peer to record method order. Assert:

```ts
expect(methods).toEqual(["initialize", "authenticate", "session/resume"]);
```

for `resumeStrategy: "resume-first"`, and assert a `methodNotFound` response produces:

```ts
expect(methods).toEqual(["initialize", "authenticate", "session/resume", "session/load"]);
```

Also retain the existing default assertion that Cursor/Grok-style options call only `session/load`.

- [ ] **Step 4: Implement opt-in resume-first continuation**

Add a helper inside `startOnce`:

```ts
const resumeExistingSession =
  options.resumeStrategy === "resume-first"
    ? runResumeThenFallbackToLoad(options.resumeSessionId)
    : runLoadSession(options.resumeSessionId);
```

Fallback only for ACP method-not-found/unsupported errors. Authentication, invalid-session, timeout, and transport errors must propagate unchanged. Update mode/config state from either response.

- [ ] **Step 5: Run shared ACP regression tests and commit**

Run:

```text
vp test run apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpSessionRuntime.test.ts apps/server/src/provider/acp/CursorAcpSupport.test.ts apps/server/src/provider/acp/GrokAcpSupport.test.ts
```

Commit:

```text
git add apps/server/src/provider/acp/AcpRuntimeModel.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpSessionRuntime.ts apps/server/src/provider/acp/AcpSessionRuntime.test.ts
git commit -m "feat(server): retain ACP commands and resume sessions"
```

### Task 4: Kimi provider health, model/options discovery, and commands

**Files:**

- Create: `apps/server/src/provider/Layers/KimiProvider.ts`
- Create: `apps/server/src/provider/Layers/KimiProvider.test.ts`
- Create: `apps/server/src/provider/acp/KimiAcpCliProbe.test.ts`

**Interfaces:**

- Produces: `buildInitialKimiProviderSnapshot(settings)`.
- Produces: `checkKimiProviderStatus(settings, environment, cwd?)`.
- Produces: `enrichKimiSnapshot(input)`.
- Produces: `kimiModelCapabilitiesFromConfigOptions(configOptions)`.
- Produces: ready snapshots with `badgeLabel: "Early Access"`, dynamically discovered models, options, slash commands, and skills.

- [ ] **Step 1: Write failing snapshot-state tests**

Cover all status branches with deterministic child-process fixtures:

```ts
expect((yield * buildInitialKimiProviderSnapshot(disabled)).status).toBe("disabled");
expect(missing.installed).toBe(false);
expect(missing.message).toContain("not installed");
expect(unsupported.message).toContain("ACP");
expect(unauthenticated.auth.status).toBe("unauthenticated");
expect(unauthenticated.message).toContain("kimi login");
expect(ready.badgeLabel).toBe("Early Access");
```

The ready fixture must advertise two models, a `thinking` option, plan/default modes, and two commands; assert the current model is `isDefault: true` and duplicate custom models are removed.

- [ ] **Step 2: Run the provider test and verify missing implementation failures**

Run `vp test run apps/server/src/provider/Layers/KimiProvider.test.ts`.

- [ ] **Step 3: Implement initial/version/auth snapshots**

Use `buildServerProvider`, `spawnAndCollect`, `parseGenericCliVersion`, and `isCommandMissingCause`. Presentation is:

```ts
const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
```

Run `kimi --version` with a 4-second timeout. Classify ACP auth-required errors separately from unsupported method/protocol and general startup failures; do not report all failures as missing binaries.

- [ ] **Step 4: Implement ACP discovery without sending a model prompt**

Create a short-lived runtime, register a session-update handler, call `start`, drain events, and collect:

```ts
{
  currentModelId: started.sessionSetupResult.models?.currentModelId,
  availableModels: started.sessionSetupResult.models?.availableModels ?? [],
  configOptions: yield* runtime.getConfigOptions,
  commands: yield* runtime.getAvailableCommands,
}
```

Build provider option descriptors from advertised `select` and `boolean` config options except the base model and mode selectors. Preserve exact Kimi option IDs so stored selections can be applied later. Mark the ACP current model as default and merge custom models through `providerModelsFromSettings`.

- [ ] **Step 5: Add an opt-in live, non-billing CLI probe**

Create `KimiAcpCliProbe.test.ts` using the `it.live`/environment-gated convention from the Grok/Cursor probes. It may run `kimi --version`, initialize ACP, authenticate, and create/close a throwaway session, but must never call `session/prompt`.

- [ ] **Step 6: Run provider/probe unit tests and commit**

Run:

```text
vp test run apps/server/src/provider/Layers/KimiProvider.test.ts apps/server/src/provider/acp/KimiAcpCliProbe.test.ts
```

The live case may be skipped by default; all deterministic cases must pass.

Commit:

```text
git add apps/server/src/provider/Layers/KimiProvider.ts apps/server/src/provider/Layers/KimiProvider.test.ts apps/server/src/provider/acp/KimiAcpCliProbe.test.ts
git commit -m "feat(server): probe Kimi models and capabilities"
```

### Task 5: Kimi adapter session and turn lifecycle

**Files:**

- Create: `apps/server/src/provider/Services/KimiAdapter.ts`
- Create: `apps/server/src/provider/Layers/KimiAdapter.ts`
- Create: `apps/server/src/provider/Layers/KimiAdapter.test.ts`
- Create: `apps/server/src/provider/testFixtures/kimiAcpMockPeer.mjs`

**Interfaces:**

- Produces: `KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError>`.
- Produces: `makeKimiAdapter(settings, options)` implementing every `ProviderAdapterShape` method.
- Produces: resume cursor `{ schemaVersion: 1, sessionId: string }`.
- Consumes: `makeKimiAcpRuntime`, canonical ACP event factories, attachment store, and `McpProviderSession`.

- [ ] **Step 1: Build a deterministic Kimi ACP mock peer**

The peer must implement newline-delimited ACP JSON-RPC for initialize/authenticate/new/resume/load/prompt/cancel/set-config-option. Scenario flags supplied through environment variables make it emit assistant chunks, plans, tools, permission requests, commands, config updates, delayed prompt completion, and process exit. It writes received method/payload records to a test-owned path for assertions.

- [ ] **Step 2: Write failing adapter tests for start, prompt, events, resume, and stop**

Cover:

```ts
const session =
  yield *
  adapter.startSession({
    threadId,
    cwd,
    modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "kimi-code/k3" },
    runtimeMode: "approval-required",
  });
expect(session.provider).toBe(ProviderDriverKind.make("kimi"));
expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "kimi-session-1" });

const turn = yield * adapter.sendTurn({ threadId, input: "Inspect this repository" });
expect(turn.threadId).toBe(threadId);
```

Collect `streamEvents` and assert assistant item start/delta/completion, tool lifecycle, plan update, and turn completion all carry the bound Kimi instance ID. Start a second adapter instance and prove events/sessions do not cross instances. Resume must call `session/resume`; stop must close only the owned peer process.

- [ ] **Step 3: Run the adapter test and verify it fails because the adapter is absent**

Run `vp test run apps/server/src/provider/Layers/KimiAdapter.test.ts`.

- [ ] **Step 4: Implement session context, locking, startup, and cleanup**

Use a per-thread session context containing:

```ts
interface KimiSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  interruptedTurnIds: Set<TurnId>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}
```

Add per-thread semaphores, instance-local PubSub, deterministic finalizers, versioned resume parsing, and MCP session cleanup. `rollbackThread` validates its input and returns the explicit error `Kimi ACP sessions do not support provider-side rollback.`

- [ ] **Step 5: Implement prompt conversion and canonical event ingestion**

Convert input and attachments based on initialized prompt capabilities. Text is always a text block; images become base64 ACP images only when advertised; text resources become resource blocks when advertised; unsupported media becomes a text block containing the resolved server-local file path. Pass the existing T3 MCP bridge returned by `McpProviderSession` in session startup.

Translate `ContentDelta`, `PlanUpdated`, `ToolCallUpdated`, assistant segment events, and prompt settlement through the shared canonical factories. Serialize prompt settlement with stop/steer operations and reject late events whose ACP session or active turn no longer matches.

- [ ] **Step 6: Implement interrupt/read/list/stop methods and verify core lifecycle**

`interruptTurn` marks the target before calling ACP cancel; `stopSession` cancels pending work, closes the child scope, removes the map entry, and publishes a closed session event. `stopAll` iterates only this adapter's map. `listSessions`, `hasSession`, and `readThread` return snapshots, never mutable references.

Run:

```text
vp test run apps/server/src/provider/Layers/KimiAdapter.test.ts apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts
```

Commit:

```text
git add apps/server/src/provider/Services/KimiAdapter.ts apps/server/src/provider/Layers/KimiAdapter.ts apps/server/src/provider/Layers/KimiAdapter.test.ts apps/server/src/provider/testFixtures/kimiAcpMockPeer.mjs
git commit -m "feat(server): add Kimi ACP sessions"
```

### Task 6: Kimi permissions, questions, modes, steering, and option changes

**Files:**

- Modify: `apps/server/src/provider/Layers/KimiAdapter.ts`
- Modify: `apps/server/src/provider/Layers/KimiAdapter.test.ts`
- Create: `apps/server/src/provider/acp/KimiUserInput.ts`
- Create: `apps/server/src/provider/acp/KimiUserInput.test.ts`

**Interfaces:**

- Produces: `extractKimiUserQuestions(request): ReadonlyArray<UserInputQuestion> | undefined`.
- Produces: exact runtime-mode permission policy at the adapter boundary.
- Produces: plan/default mode resolution from advertised ACP modes.
- Preserves: user questions remain interactive in Full access.

- [ ] **Step 1: Write failing question-shape parser tests**

Parse Kimi's documented `AskUserQuestion` input:

```ts
expect(extractKimiUserQuestions(request)).toEqual([
  {
    id: "framework",
    header: "Framework",
    question: "Which framework should I use?",
    options: [
      { label: "React", description: "Use React." },
      { label: "Vue", description: "Use Vue." },
    ],
    multiSelect: false,
  },
]);
```

Reject malformed questions, empty labels, fewer than two valid choices, or arbitrary tool requests. Preserve stable IDs from upstream when present and otherwise derive deterministic IDs from array position/header.

- [ ] **Step 2: Implement the parser and run its focused test**

Run `vp test run apps/server/src/provider/acp/KimiUserInput.test.ts`, observe the missing-function failure, implement strict unknown-to-typed parsing, and rerun to green.

- [ ] **Step 3: Write failing permission-mode tests**

For the same ACP request stream, assert:

| T3 mode             | File edit                                                   | Command        | Kimi question    |
| ------------------- | ----------------------------------------------------------- | -------------- | ---------------- |
| `approval-required` | opens approval                                              | opens approval | opens user input |
| `auto-accept-edits` | auto allows                                                 | opens approval | opens user input |
| `auto`              | selects advertised Kimi auto mode; otherwise opens approval | same           | opens user input |
| `full-access`       | auto allows                                                 | auto allows    | opens user input |

Assert `acceptForSession`, `accept`, and `decline` choose permission options by semantic kind, never array position. Missing semantic options return a typed request error.

- [ ] **Step 4: Implement pending approvals and structured questions**

Store Deferred entries by canonical request ID. Permission-shaped requests publish `request.opened` and wait for `respondToRequest`. Question-shaped requests publish `user-input.requested`, wait for `respondToUserInput`, convert selected labels/free text to the ACP response option accepted by Kimi, and publish resolution. Interrupt, stop, and process exit resolve both maps as cancelled.

- [ ] **Step 5: Write failing plan/mode and steering tests**

Advertise modes `default`, `auto`, and `plan`. Assert plan interaction calls `setMode("plan")`, returning to default calls `setMode("default")`, and `auto` calls `setMode("auto")`. When a mode is absent, assert no fabricated ID is sent. Send a second prompt while the first is active and assert both belong to one T3 turn and only the last in-flight prompt completes it.

- [ ] **Step 6: Implement mode resolution, steering settlement, and dynamic option updates**

Resolve modes by exact normalized ID/name first, then conservative aliases. Apply model, options, and mode before each prompt. Refresh config options after model mutation and drop stale selections with a bounded warning. Maintain `promptsInFlight`, active session identity, and interrupted-turn checks through final settlement.

- [ ] **Step 7: Run the complete adapter slice and commit**

Run:

```text
vp test run apps/server/src/provider/acp/KimiUserInput.test.ts apps/server/src/provider/Layers/KimiAdapter.test.ts
```

Commit:

```text
git add apps/server/src/provider/acp/KimiUserInput.ts apps/server/src/provider/acp/KimiUserInput.test.ts apps/server/src/provider/Layers/KimiAdapter.ts apps/server/src/provider/Layers/KimiAdapter.test.ts
git commit -m "feat(server): support Kimi interactions and modes"
```

### Task 7: Kimi auxiliary generation and built-in driver registration

**Files:**

- Create: `apps/server/src/textGeneration/KimiTextGeneration.ts`
- Create: `apps/server/src/textGeneration/KimiTextGeneration.test.ts`
- Create: `apps/server/src/provider/Drivers/KimiDriver.ts`
- Create: `apps/server/src/provider/Drivers/KimiDriver.test.ts`
- Modify: `apps/server/src/provider/builtInDrivers.ts`
- Create: `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.test.ts`
- Modify: `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts`

**Interfaces:**

- Produces: all four `TextGeneration` methods backed by a scoped Kimi ACP session.
- Produces: `KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv>`.
- Registers: Kimi in `BUILT_IN_DRIVERS` and `BuiltInDriversEnv`.

- [ ] **Step 1: Write failing structured text-generation tests**

Use the mock peer to return JSON for thread title, branch, commit, and change request. Assert selected model application, sanitization, invalid JSON, empty response, cancelled response, timeout, and process cleanup. A representative assertion is:

```ts
expect(
  yield *
    textGeneration.generateThreadTitle({
      cwd,
      message: "Add Kimi support",
      modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "kimi-code/k3" },
    }),
).toEqual({ title: "Add Kimi support" });
```

- [ ] **Step 2: Run the generation test red, then implement `KimiTextGeneration`**

Run `vp test run apps/server/src/textGeneration/KimiTextGeneration.test.ts`.

Implement one scoped `runKimiJson` helper using `build*Prompt`, `extractJsonObject`, existing sanitizers, `makeKimiAcpRuntime`, a 180-second timeout, and `Effect.scoped`. It must register assistant update collection before `start`, apply the selected model, send exactly one text prompt, decode the requested schema, and close on every path.

- [ ] **Step 3: Write failing driver construction tests**

Assert metadata, defaults, continuation identity, environment, instance stamping, maintenance package, adapter binding, and text-generation binding:

```ts
expect(KimiDriver.driverKind).toBe(ProviderDriverKind.make("kimi"));
expect(KimiDriver.metadata).toEqual({ displayName: "Kimi", supportsMultipleInstances: true });
expect(KimiDriver.defaultConfig()).toMatchObject({ enabled: false, binaryPath: "kimi" });
```

- [ ] **Step 4: Implement `KimiDriver` and maintenance resolution**

Compose `makeKimiEnvironment` after `mergeProviderInstanceEnvironment`, use the resolved home for continuation identity, construct adapter/text generation, and use `makeManagedServerProvider` with the Kimi snapshot functions. Configure package maintenance for `@moonshot-ai/kimi-code`; package-manager-owned paths receive the matching global update command and standalone/native paths remain manual-only.

- [ ] **Step 5: Register Kimi and prove hydration/instance isolation**

Import `KimiDriver` in `builtInDrivers.ts`, include `KimiDriverEnv` in the union, and place `KimiDriver` before OpenCode. Create `ProviderInstanceRegistryHydration.test.ts` with a pure test that decodes `{ providers: { kimi: {} } }`, calls `deriveProviderInstanceConfigMap`, and asserts the default `kimi` instance has driver kind `kimi` and the decoded Kimi config. Add a registry-live test with two Kimi instance envelopes that have different homes/environments; assert distinct adapters and continuation keys.

- [ ] **Step 6: Run focused backend tests and commit**

Run:

```text
vp test run apps/server/src/textGeneration/KimiTextGeneration.test.ts apps/server/src/provider/Drivers/KimiDriver.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts
```

Commit:

```text
git add apps/server/src/textGeneration/KimiTextGeneration.ts apps/server/src/textGeneration/KimiTextGeneration.test.ts apps/server/src/provider/Drivers/KimiDriver.ts apps/server/src/provider/Drivers/KimiDriver.test.ts apps/server/src/provider/builtInDrivers.ts apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts
git commit -m "feat(server): register Kimi provider driver"
```

### Task 8: Web and desktop presentation

**Files:**

- Modify: `apps/web/src/components/Icons.tsx`
- Modify: `apps/web/src/components/settings/providerDriverMeta.ts`
- Create: `apps/web/src/components/settings/providerDriverMeta.test.ts`
- Modify: `apps/web/src/components/chat/providerIconUtils.ts`
- Create: `apps/web/src/components/chat/providerIconUtils.test.ts`
- Modify: `apps/web/src/session-logic.ts`
- Modify: `apps/web/src/session-logic.test.ts`
- Modify: `apps/web/src/lib/contextWindow.test.ts`

**Interfaces:**

- Produces: `KimiIcon` and Kimi icon lookup.
- Produces: Kimi provider settings definition with Early Access badge and `KimiSettings` form.
- Produces: available Kimi model-picker entry with `pickerSidebarBadge: "new"`.
- Preserves: generic unknown-provider fallbacks.

- [ ] **Step 1: Write failing metadata and provider-list tests**

Assert:

```ts
expect(getDriverOption(ProviderDriverKind.make("kimi"))).toMatchObject({
  value: ProviderDriverKind.make("kimi"),
  label: "Kimi",
  badgeLabel: "Early Access",
  settingsSchema: KimiSettings,
});
expect(PROVIDER_OPTIONS).toContainEqual({
  value: ProviderDriverKind.make("kimi"),
  label: "Kimi",
  available: true,
  pickerSidebarBadge: "new",
});
```

Assert the icon map returns `KimiIcon` and `formatProviderDisplayName("kimi")` returns `Kimi`.

- [ ] **Step 2: Run the web tests and verify missing metadata failures**

Run:

```text
vp test run apps/web/src/components/settings/providerDriverMeta.test.ts apps/web/src/components/chat/providerIconUtils.test.ts apps/web/src/session-logic.test.ts apps/web/src/lib/contextWindow.test.ts
```

- [ ] **Step 3: Add the Kimi icon and client definition**

Add a monochrome `KimiIcon` using an official Moonshot/Kimi vector source that permits repository redistribution, following the `Icon` component/viewBox/className conventions. Register:

```ts
{
  value: ProviderDriverKind.make("kimi"),
  label: "Kimi",
  icon: KimiIcon,
  badgeLabel: "Early Access",
  settingsSchema: KimiSettings,
}
```

Add it to `PROVIDER_ICON_BY_PROVIDER` and `PROVIDER_OPTIONS`. The desktop wrapper requires no separate code because it renders the web provider settings and starts the same server driver.

- [ ] **Step 4: Run web tests and commit**

Run the Step 2 command again. Expected: all selected tests pass.

Commit:

```text
git add apps/web/src/components/Icons.tsx apps/web/src/components/settings/providerDriverMeta.ts apps/web/src/components/settings/providerDriverMeta.test.ts apps/web/src/components/chat/providerIconUtils.ts apps/web/src/components/chat/providerIconUtils.test.ts apps/web/src/session-logic.ts apps/web/src/session-logic.test.ts apps/web/src/lib/contextWindow.test.ts
git commit -m "feat(web): expose Kimi provider controls"
```

### Task 9: Mobile presentation and Early Access status

**Files:**

- Modify: `apps/mobile/src/components/ProviderIcon.tsx`
- Create: `apps/mobile/src/components/ProviderIcon.test.tsx`
- Modify: `apps/mobile/src/lib/modelOptions.ts`
- Modify: `apps/mobile/src/lib/modelOptions.test.ts`
- Modify: `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx`
- Modify: `apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts`

**Interfaces:**

- Produces: Kimi icon and canonical label on mobile.
- Produces: Early Access badge text from `ServerProvider.badgeLabel` in the provider group/header where mobile shows provider metadata.
- Preserves: Kimi stays outside `PRIMARY_PROVIDER_DRIVERS` while Early Access, so it appears in the existing secondary provider grouping rather than displacing Codex/Claude.

- [ ] **Step 1: Write failing mobile label/icon/group tests**

Add a Kimi provider snapshot to `modelOptions.test.ts`:

```ts
{
  instanceId: "kimi",
  driver: "kimi",
  displayName: undefined,
  badgeLabel: "Early Access",
  models: [{ slug: "kimi-code/k3", name: "Kimi K3", isCustom: false, capabilities: null }],
}
```

Assert its group label is `Kimi`, model subtitle is `Kimi`, the provider icon renders the Kimi branch, and the secondary group state retains `Early Access`.

- [ ] **Step 2: Run mobile tests red, then implement the presentation**

Run:

```text
vp test run apps/mobile/src/components/ProviderIcon.test.tsx apps/mobile/src/lib/modelOptions.test.ts apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts
```

Add an explicit `provider.driver === "kimi"` label, a Kimi SVG branch in `ProviderIcon`, and render the existing snapshot `badgeLabel` adjacent to the provider group title with the same subdued badge style used elsewhere in mobile. Do not add Kimi to `PRIMARY_PROVIDER_DRIVERS` during Early Access.

- [ ] **Step 3: Rerun mobile tests and commit**

Run the Step 2 command again. Expected: all selected tests pass.

Commit:

```text
git add apps/mobile/src/components/ProviderIcon.tsx apps/mobile/src/components/ProviderIcon.test.tsx apps/mobile/src/lib/modelOptions.ts apps/mobile/src/lib/modelOptions.test.ts apps/mobile/src/features/threads/ThreadSettingsSheet.tsx apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts
git commit -m "feat(mobile): show Kimi provider models"
```

### Task 10: Orchestration integration, documentation, and complete focused verification

**Files:**

- Create: `apps/server/integration/kimiProvider.integration.test.ts`
- Modify: `docs/user/install.md`
- Create: `docs/user/providers-kimi.md`
- Modify: `docs/internals/providers.md`
- Modify: `docs/internals/overview.md`
- Modify: `docs/internals/glossary.md`
- Modify: `apps/marketing/src/pages/index.astro`
- Create: `apps/marketing/public/harnesses/kimi.svg`

**Interfaces:**

- Produces: one end-to-end server proof from orchestration command through Kimi canonical events and checkpoint receipt.
- Produces: user installation/login/multi-instance/permissions/troubleshooting documentation.
- Updates: every explicit five-provider list to six providers without implying General Availability.

- [ ] **Step 1: Write the failing orchestration integration test**

Use the deterministic Kimi mock peer and existing provider integration harness. Dispatch project/thread creation and `thread.turn.start`, then wait on provider ingestion receipts and worker drains. Assert the final projection contains:

```ts
expect(snapshot.session?.providerName).toBe("kimi");
expect(snapshot.session?.providerInstanceId).toBe(ProviderInstanceId.make("kimi"));
expect(snapshot.messages.at(-1)?.text).toBe("Kimi integration response.");
expect(snapshot.latestTurn?.status).toBe("completed");
expect(snapshot.checkpoints.length).toBeGreaterThan(0);
```

Do not use sleeps or polling.

- [ ] **Step 2: Run the integration test red, wire any missing generic registration, and rerun**

Run:

```text
vp test run apps/server/integration/kimiProvider.integration.test.ts
```

Fix only missing Kimi registration/event plumbing exposed by this test. Rerun until it passes.

- [ ] **Step 3: Write shipped-product Kimi documentation**

`providers-kimi.md` must cover official installation links, `kimi login`, enabling Early Access Kimi, binary path, `KIMI_CODE_HOME`, multiple accounts/homes, environment secrets, model/thinking/plan selection, permission behavior, session continuation, remote-server placement, and upstream ACP limitations. Use user-facing language and omit repository source paths.

Add Kimi to the install provider table. Update internal built-in driver tables and every sentence that says five built-in providers. Add the Kimi driver/source link in `providers.md`.

- [ ] **Step 4: Update marketing provider copy without hiding Early Access status**

Add the official redistributable Kimi SVG asset, a Kimi harness card, and Kimi to enumerated provider copy. Label it `Kimi Code (Early Access)` in the provider card so the marketing surface does not imply GA.

- [ ] **Step 5: Run the complete focused test set**

Run:

```text
vp test run packages/contracts/src/settings.test.ts packages/contracts/src/model.test.ts apps/server/src/provider/Drivers/KimiHome.test.ts apps/server/src/provider/Drivers/KimiSkills.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpSessionRuntime.test.ts apps/server/src/provider/acp/KimiAcpSupport.test.ts apps/server/src/provider/Layers/KimiProvider.test.ts apps/server/src/provider/Layers/KimiAdapter.test.ts apps/server/src/provider/acp/KimiUserInput.test.ts apps/server/src/textGeneration/KimiTextGeneration.test.ts apps/server/src/provider/Drivers/KimiDriver.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts apps/server/integration/kimiProvider.integration.test.ts apps/web/src/components/settings/providerDriverMeta.test.ts apps/web/src/components/chat/providerIconUtils.test.ts apps/web/src/session-logic.test.ts apps/mobile/src/components/ProviderIcon.test.tsx apps/mobile/src/lib/modelOptions.test.ts apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts
```

Expected: zero failures and no unexpected warnings.

- [ ] **Step 6: Run targeted type checks, lint, formatting, and asset verification**

Run:

```text
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp lint packages/contracts/src/settings.ts packages/contracts/src/model.ts apps/server/src/provider apps/server/src/textGeneration/KimiTextGeneration.ts apps/web/src/components apps/web/src/session-logic.ts apps/mobile/src/components/ProviderIcon.tsx apps/mobile/src/lib/modelOptions.ts apps/mobile/src/features/threads/ThreadSettingsSheet.tsx
vp fmt --check
node scripts/export-brand-icons.ts --check
git diff --check
```

Do not replace these targeted filters with a repo-wide check.

- [ ] **Step 7: Audit every surface and upstream limitation**

Search:

```text
rg -n 'five drivers|Codex, Claude, Cursor, Grok|ProviderDriverKind.make\(|PROVIDER_DISPLAY_NAMES|PROVIDER_OPTIONS|PROVIDER_ICON_BY_PROVIDER|PRIMARY_PROVIDER_DRIVERS' apps packages docs
```

Confirm web, desktop, mobile, all connection modes, models/options, modes, stop/resume reverse states, text generation, docs, and provider instance settings are either implemented or explicitly documented as upstream ACP limitations. Do not add Kimi to Codex/Claude-only usage transcript lists.

- [ ] **Step 8: Commit the integration and documentation slice**

```text
git add apps/server/integration/kimiProvider.integration.test.ts docs/user/install.md docs/user/providers-kimi.md docs/internals/providers.md docs/internals/overview.md docs/internals/glossary.md apps/marketing/src/pages/index.astro apps/marketing/public/harnesses/kimi.svg
git commit -m "docs: document Kimi provider support"
```

- [ ] **Step 9: Request explicit approval for real-client verification**

Report the automated evidence and ask whether to run one integrated web pass with `test-t3-app` and one mobile pass with `test-t3-mobile`. Do not launch either without approval.
