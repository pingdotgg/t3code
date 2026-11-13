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
  readonly reopen?: boolean;
  readonly fork?: boolean;
  readonly model?: string;
}
interface Scenario {
  readonly name: string;
  readonly runtimeMode: "full-access" | "approval-required";
  readonly mcp?: boolean;
  readonly claudeSettings?: unknown;
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

const selection = (model?: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
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
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
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
    const settings = Schema.decodeSync(ClaudeSettings)({ binaryPath: stub });
    // As createClaudeAdapterV2 builds it.
    const environment = yield* makeClaudeEnvironment(
      settings,
      yield* mergeClaudeProcessEnvironment(settings, undefined, baseEnvironment),
    );
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
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
    });
    const providerSessionId = ProviderSessionId.make("provider-session-conformance");
    if (scenario.mcp === true) {
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment-conformance"),
        threadId: ThreadId.make(THREAD),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
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
      yield* session.runtime.startTurn({
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
      });
      const answers = [...(step.answers ?? [])];
      let interrupted = step.interrupt !== true;
      for (;;) {
        const event = yield* Queue.take(session.events).pipe(Effect.timeout("60 seconds"));
        if (event.type === "provider_thread.updated") thread = event.providerThread;
        if (event.type === "provider_turn.updated") {
          turns.set(event.providerTurn.id, event.providerTurn);
          if (!interrupted && event.providerTurn.tokenUsage != null) {
            interrupted = true;
            yield* session.runtime
              .interruptTurn({ providerThread: thread, providerTurnId: event.providerTurn.id })
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
