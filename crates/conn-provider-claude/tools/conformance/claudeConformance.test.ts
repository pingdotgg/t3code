// Conformance tool, not a test of the adapter. `run.sh` copies this file next to
// ClaudeAdapterV2.ts in the Conn monorepo and runs it with vitest. It drives the T3 server's own
// ClaudeAdapterV2 with its real Agent SDK query runner against stub-claude, through the scenarios
// in scenarios.json, so the stub records what the CLI receives from the T3 server. The Conn
// Server runs the same scenarios (examples/conformance.rs); compare.mjs diffs the records.
// @effect-diagnostics nodeBuiltinImport:off -- reads the scenario file and the base environment
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  ChatImageAttachment,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as PortScanner from "../../preview/PortScanner.ts";
import { makeClaudeEnvironment, mergeClaudeProcessEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fixPath } from "../../os-jank.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

const SCENARIOS = process.env.CONFORMANCE_SCENARIOS ?? "";
const ROOT = process.env.CONFORMANCE_ROOT ?? "";
const WORKSPACE = process.env.CONFORMANCE_WORKSPACE ?? "";
const ATTACHMENTS = process.env.CONFORMANCE_ATTACHMENTS ?? "";
const ONLY = (process.env.CONFORMANCE_ONLY ?? "").split(/\s+/).filter(Boolean);
const BASE_ENV_FILE = process.env.CONFORMANCE_BASE_ENV ?? NodePath.join(NodePath.dirname(ROOT), "base.env");
// Must match examples/conformance.rs.
const THREAD = "thread-conformance";
const MCP_URL = "http://127.0.0.1:9/mcp";
const MCP_AUTHORIZATION = "Bearer conformance-credential";

interface Step {
  readonly turn?: string;
  readonly image?: boolean;
  readonly answers?: ReadonlyArray<string>;
  readonly interrupt?: boolean;
  // Stop with no turn running: the latest turn settled while background work still runs.
  readonly stop?: boolean;
  // Stop while the turn starts (the CLI holds a control request, see the scenario's `hold`).
  readonly stopDuringStart?: boolean;
  readonly reopen?: boolean;
  readonly fork?: boolean;
  readonly model?: string;
  /** A selection sent to the running turn (applyModelSelection) once it reports token usage. */
  readonly liveSelection?: {
    readonly model?: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
  };
}
interface Scenario {
  readonly name: string;
  readonly runtimeMode: "full-access" | "approval-required";
  readonly mcp?: boolean;
  /** Spread over the runtime policy, as T3's RuntimePolicy.layerWithOverride does. */
  readonly policyOverride?: { readonly approvalPolicy?: unknown; readonly sandboxPolicy?: unknown };
  readonly claudeSettings?: unknown;
  /**
   * A `providerInstances` entry: its id, `config` (ClaudeSettings) and `environment`, as
   * createClaudeAdapterV2 receives them. `{side}` in a string value is "t3" here.
   */
  readonly instance?: {
    readonly id?: string;
    readonly config?: Record<string, unknown>;
    readonly environment?: ReadonlyArray<{ name: string; value: string; sensitive?: boolean }>;
  };
  readonly steps: ReadonlyArray<Step>;
}

const file =
  SCENARIOS === ""
    ? { model: "claude-haiku-5-5", scenarios: [] as Array<Scenario> }
    : (JSON.parse(NodeFS.readFileSync(SCENARIOS, "utf8")) as {
        model: string;
        scenarios: Array<Scenario>;
      });
const scenarios = file.scenarios.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));

// The environment the T3 server process would have: run.sh's base environment, not vitest's.
const baseEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
  (NodeFS.existsSync(BASE_ENV_FILE) ? NodeFS.readFileSync(BASE_ENV_FILE, "utf8") : "")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

// The T3 server's start-up step: PATH, __MISE_DIFF and JAVA_HOME from the login shell into
// its environment (fixPath, os-jank.ts), here into the base environment the adapter reads.
if (baseEnvironment.SHELL !== undefined) {
  await Effect.runPromise(
    fixPath().pipe(
      Effect.provideService(HostProcess.Environment, baseEnvironment),
      Effect.provideService(HostProcess.Platform, process.platform),
      Effect.provide(NodeServices.layer),
    ),
  );
}

// The scenario's instance id (`instance.id`), set as each scenario starts.
let INSTANCE = "claudeAgent";

const selection = (model?: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(INSTANCE),
  model: model ?? file.model,
});

const runQueryRunner = ClaudeAdapterV2.layerQueryRunner.pipe(
  Layer.provide(PortScanner.layerTest),
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const appThread = (
  id: string,
  runtimeMode: Scenario["runtimeMode"],
  model: ModelSelection,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-conformance"),
  title: "Conformance",
  providerInstanceId: ProviderInstanceId.make(INSTANCE),
  modelSelection: model,
  runtimeMode,
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Waits until a CLI start of the scenario got the request its `hold` file names. */
const waitForHeld = (scenario: Scenario) =>
  Effect.promise(async () => {
    const records = NodePath.join(ROOT, scenario.name, "records");
    for (let i = 0; i < 600; i++) {
      const held = (NodeFS.existsSync(records) ? NodeFS.readdirSync(records) : []).some((f) => {
        try {
          return JSON.parse(NodeFS.readFileSync(NodePath.join(records, f), "utf8")).held !== undefined;
        } catch {
          return false;
        }
      });
      if (held) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${scenario.name}: the CLI never got the held request`);
  });

const runScenario = (scenario: Scenario) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
    const stub = NodePath.join(ROOT, scenario.name, "stub-claude");
    const settingsFile =
      baseEnvironment.CLAUDE_CONFIG_DIR === undefined
        ? undefined
        : NodePath.join(baseEnvironment.CLAUDE_CONFIG_DIR, "settings.json");
    if (settingsFile !== undefined && scenario.claudeSettings !== undefined) {
      NodeFS.writeFileSync(settingsFile, JSON.stringify(scenario.claudeSettings));
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(settingsFile, { force: true })));
    }
    INSTANCE = scenario.instance?.id ?? "claudeAgent";
    const side = (value: unknown) => (typeof value === "string" ? value.replaceAll("{side}", "t3") : value);
    const instanceConfig = Object.fromEntries(
      Object.entries(scenario.instance?.config ?? {}).map(([key, value]) => [key, side(value)]),
    );
    const instanceEnvironment = scenario.instance?.environment?.map((variable) => ({
      ...variable,
      value: side(variable.value) as string,
    }));
    const decoded = Schema.decodeSync(ClaudeSettings)({ binaryPath: stub, ...instanceConfig });
    // As createClaudeAdapterV2 builds it.
    const environment = yield* makeClaudeEnvironment(
      decoded,
      yield* mergeClaudeProcessEnvironment(decoded, instanceEnvironment as any, baseEnvironment),
    );
    const settings = {
      ...decoded,
      binaryPath: expandHomePath(decoded.binaryPath, baseEnvironment.HOME ?? ""),
    };
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ProviderInstanceId.make(INSTANCE),
      settings,
      environment,
      attachmentsDir: ATTACHMENTS,
      fileSystem,
      path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      continuationRequests: { offer: () => Effect.void },
      queryRunner: runner,
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: scenario.runtimeMode,
      interactionMode: "default",
      cwd: WORKSPACE,
      ...scenario.policyOverride,
    });
    const providerSessionId = ProviderSessionId.make("provider-session-conformance");
    if (scenario.mcp === true) {
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment-conformance"),
        threadId: ThreadId.make(THREAD),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(INSTANCE),
        endpoint: MCP_URL,
        authorizationHeader: MCP_AUTHORIZATION,
        browserToolsAvailable: false,
      });
    }
    const open = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId: ThreadId.make(THREAD),
          providerSessionId,
          modelSelection: selection(),
          runtimePolicy,
          promptSuggestions: Effect.succeed(false),
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkIn(scope),
      );
      return { runtime, events, scope };
    });
    let session = yield* open;
    let thread: OrchestrationV2ProviderThread = yield* session.runtime.ensureThread({
      threadId: ThreadId.make(THREAD),
      modelSelection: selection(),
      runtimePolicy,
    });
    let threadId = THREAD;
    const turns = new Map<string, OrchestrationV2ProviderTurn>();
    let n = 0;
    const now = yield* DateTime.now;
    for (const step of scenario.steps) {
      if (step.reopen === true) {
        yield* Scope.close(session.scope, Exit.void);
        session = yield* open;
        thread = yield* session.runtime.resumeThread({
          providerThread: thread,
          threadId: ThreadId.make(THREAD),
          modelSelection: selection(),
          runtimePolicy,
        });
        continue;
      }
      if (step.stop === true) {
        // As ProviderTurnControlService.interrupt calls it for a Stop on a settled turn.
        const latest = [...turns.values()].at(-1);
        if (latest === undefined) throw new Error("stop needs a turn before it");
        yield* session.runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: latest.id,
          requestRuntimeRestart: true,
        });
        continue;
      }
      if (step.fork === true) {
        thread = yield* session.runtime.forkThread({
          sourceProviderThread: thread,
          sourceProviderTurns: [...turns.values()],
          targetThreadId: ThreadId.make("thread-conformance-fork"),
        });
        threadId = "thread-conformance-fork";
        n = 0;
        continue;
      }
      n += 1;
      const model = selection(step.model);
      const attachments =
        step.image === true
          ? [
              ChatImageAttachment.make({
                type: "image",
                id: ChatAttachmentId.make("attach-1"),
                name: "red.png",
                mimeType: "image/png",
                sizeBytes: NodeFS.statSync(NodePath.join(ATTACHMENTS, "attach-1.png")).size,
              }),
            ]
          : [];
      const turnInput = {
        appThread: appThread(threadId, scenario.runtimeMode, model, now),
        threadId: ThreadId.make(threadId),
        runId: RunId.make(`run-${n}`),
        runOrdinal: n,
        providerTurnOrdinal: n,
        attemptId: RunAttemptId.make(`attempt-${n}`),
        rootNodeId: NodeId.make(`node-${n}`),
        providerThread: thread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message-${n}`),
          text: step.turn ?? "",
          attachments,
        },
        modelSelection: model,
        runtimePolicy,
      } satisfies Parameters<typeof session.runtime.startTurn>[0];
      if (step.stopDuringStart === true) {
        // A Stop before the provider turn exists: T3's EffectWorker interrupts the running
        // provider-turn.start (raceFirst with its cancellation), and waits for it to end.
        const starting = yield* session.runtime
          .startTurn(turnInput)
          .pipe(Effect.forkIn(session.scope));
        yield* waitForHeld(scenario);
        yield* Fiber.interrupt(starting);
        console.log(`${scenario.name}: turn ${n} abandoned`);
        continue;
      }
      yield* session.runtime.startTurn(turnInput);
      const answers = [...(step.answers ?? [])];
      let interrupted = step.interrupt !== true;
      // The Stop runs as T3's EffectWorker runs it, beside the turn's events. The outbox runs a
      // thread's effects one at a time, so the next step waits for the Stop to finish.
      let interrupting: Fiber.Fiber<void, unknown> | undefined;
      let liveSelection = step.liveSelection;
      for (;;) {
        const event = yield* Queue.take(session.events).pipe(Effect.timeout("60 seconds"));
        if (event.type === "provider_thread.updated") thread = event.providerThread;
        if (event.type === "provider_turn.updated") {
          turns.set(event.providerTurn.id, event.providerTurn);
          if (liveSelection !== undefined && event.providerTurn.tokenUsage != null) {
            const change = liveSelection;
            liveSelection = undefined;
            yield* session.runtime.applyModelSelection!({
              providerThread: thread,
              modelSelection: {
                ...selection(change.model),
                ...(change.options === undefined ? {} : { options: change.options }),
              } as ModelSelection,
            });
          }
          if (!interrupted && event.providerTurn.tokenUsage != null) {
            interrupted = true;
            // As ProviderTurnControlService.interrupt calls it for a user's Stop.
            interrupting = yield* session.runtime
              .interruptTurn({
                providerThread: thread,
                providerTurnId: event.providerTurn.id,
                requestRuntimeRestart: true,
              })
              .pipe(Effect.forkIn(session.scope));
          }
        }
        if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending") {
          yield* session.runtime.respondToRuntimeRequest({
            requestId: event.runtimeRequest.id,
            decision: (answers.shift() ?? "decline") as "accept" | "decline",
          });
        }
        if (event.type === "turn.terminal") {
          console.log(`${scenario.name}: turn ${n} ${event.status}`);
          if (interrupting !== undefined) yield* Fiber.join(interrupting);
          break;
        }
      }
    }
    yield* Scope.close(session.scope, Exit.void);
  });

describe("conformance: what claude receives from ClaudeAdapterV2", () => {
  it.live.each(scenarios.map((s) => [s.name, s] as const))(
    "%s",
    ([, scenario]) =>
      runScenario(scenario).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            runQueryRunner,
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    120_000,
  );
});
