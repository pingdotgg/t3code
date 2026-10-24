// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetchInEffect:off schemaSyncInEffect:off globalConsole:off preferSchemaOverJson:off - Offline development seed writes synthetic history into a disposable home.
import * as NodeFS from "node:fs";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnItemId,
  ProviderInstanceId,
  ProviderDriverKind,
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ServerConfig from "../src/config.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as ApplicationEvents from "../src/persistence/OrchestrationEventStore.ts";
import * as CheckpointStore from "../src/checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../src/git/GitWorkflowService.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as McpSessionRegistryTestkit from "../src/mcp/McpSessionRegistry.testkit.ts";
import * as ProviderRegistry from "../src/provider/ProviderInstanceRegistry.ts";
import * as SourceControlRegistry from "../src/sourceControl/SourceControlProviderRegistry.ts";
import * as VcsRegistry from "../src/vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import * as RuntimeLayer from "../src/orchestration-v2/runtimeLayer.ts";
import * as Orchestrator from "../src/orchestration-v2/Orchestrator.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import { CodexProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { limitRecoveryCommand } from "../src/orchestration-v2/UsageLimitRecoveryWorker.ts";

// Seeds SYNTHETIC usage-limit threads into a disposable T3 home for web evidence of the
// usage-limit recovery banner. Run it from the checkout under test with its dev server stopped:
//   node apps/server/scripts/usage-limit-web-evidence-seed.ts --home /tmp/<dir>/.t3 --row W1 --stage init
// Rows: W0 limited only; W1 notification wake completes before reset; W2 as W1 but armed;
// W4q as W1 plus a held queued message; W7 wake completes after reset (needs --reset-delay-ms
// small, then stage "wake" after the reset); W8 a user turn completes before reset.
// Stages: init (source run fails with a synthetic usage_limit), wake (notification run completes),
// wake-running (notification run left running), finish (complete the newest run), user (user turn
// completes). The provider is a Codex mock peer configured by init; no real quota is involved.
const { values } = NodeUtil.parseArgs({
  options: {
    home: { type: "string" },
    row: { type: "string" },
    stage: { type: "string" },
    "reset-delay-ms": { type: "string", default: String(30 * 60_000) },
    arm: { type: "boolean", default: false },
    "hold-queue": { type: "boolean", default: false },
    title: { type: "string" },
  },
});
NodeAssert.ok(values.home && values.row && values.stage, "--home, --row and --stage are required");
const home = NodePath.resolve(values.home);
NodeAssert.ok(
  home.startsWith("/tmp/") &&
    !home.includes("/.t3/userdata/") &&
    home !== NodePath.resolve(process.env.HOME ?? "~", ".t3"),
  "Home must be a disposable directory under /tmp, never live T3 state",
);
const row = values.row;
const stage = values.stage;
const failure = {
  class: "usage_limit" as const,
  message: "Plan limit reached. (SYNTHETIC FIXTURE)",
  code: "usageLimitExceeded",
  retryable: null,
};
const log = (kind: string, data: unknown) =>
  console.log(
    JSON.stringify({
      kind,
      boundary: "OFFLINE SEED (server stopped)",
      row,
      stage,
      at: new Date().toISOString(),
      data,
    }),
  );

if (stage === "init") {
  const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
  NodeFS.mkdirSync(`${home}/userdata`, { recursive: true });
  NodeFS.writeFileSync(`${home}/DISPOSABLE`, "Synthetic usage-limit evidence; safe to delete\n");
  const workspace = `${home}/workspace-${row}`;
  if (!NodeFS.existsSync(workspace)) {
    NodeFS.mkdirSync(workspace, { recursive: true });
    NodeChildProcess.execFileSync("git", ["init", "-q", workspace]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Evidence",
      "-c",
      "user.email=evidence@localhost",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
  }
  const wire = JSON.parse(
    NodeFS.readFileSync(
      `${repoRoot}/apps/server/src/provider/testFixtures/codexMultiAgentWire.json`,
      "utf8",
    ),
  );
  // The dev server reads this through T3_CODEX_COLLAB_SCRIPT; holdTurnOpen keeps a continuation visible.
  NodeFS.writeFileSync(
    `${home}/mock.json`,
    JSON.stringify({ rootThreadId: wire.rootThreadId, notifications: [], holdTurnOpen: true }),
  );
  NodeFS.writeFileSync(
    `${home}/userdata/settings.json`,
    JSON.stringify({
      autoResumeLimitedThreads: false,
      snoozeLimitedThreads: false,
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          displayName: "Synthetic fixture",
          config: {
            binaryPath: `${repoRoot}/apps/server/src/provider/testFixtures/codexCollabMockPeer.sh`,
            homePath: `${home}/codex-home`,
          },
        },
      },
    }),
  );
  NodeFS.mkdirSync(`${home}/codex-home`, { recursive: true });
}

const config = ServerConfig.layerTest(process.cwd(), home);
const platform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused"),
  }),
);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");
const instance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Synthetic Codex",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  textGeneration: {} as ProviderInstance["textGeneration"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("offline fixture must not open a provider"),
  } as ProviderInstance["orchestrationAdapter"],
} satisfies ProviderInstance;
const registry = Layer.succeed(ProviderRegistry.ProviderInstanceRegistry, {
  getInstance: () => Effect.succeed(instance),
  listInstances: Effect.succeed([instance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});
const vcs = VcsRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(config),
  Layer.provide(platform),
);
const layers = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
  ProjectStore.layer,
  ApplicationEvents.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(Sqlite.layerConfig),
  Layer.provide(CheckpointStore.layer.pipe(Layer.provide(vcs))),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(registry),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.die("unused"),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(config),
  Layer.provide(platform),
);

const threadId = ThreadId.make(`evidence:${row}`);
const projectId = ProjectId.make(`evidence:project:${row}`);
const manifestPath = `${home}/fixture-${row}.json`;

await Effect.runPromise(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const write = Effect.fnUntraced(function* (events: Parameters<typeof sink.write>[0]["events"]) {
      log(
        "synthetic-events",
        events.map((event) => event.type),
      );
      yield* sink.write({ events });
    });
    const completeRun = Effect.fnUntraced(function* (
      run: OrchestrationV2ThreadProjection["runs"][number],
      text: string,
    ) {
      const now = yield* DateTime.now;
      const base = {
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* write([
        {
          id: EventId.make(`evidence:output:${row}:${run.id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...base,
            id: TurnItemId.make(`evidence:output:${row}:${run.id}`),
            ordinal: 2,
            type: "assistant_message",
            messageId: MessageId.make(`evidence:output:${row}:${run.id}`),
            text,
            streaming: false,
          },
        },
        {
          id: EventId.make(`evidence:checkpoint:${row}:${run.id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...base,
            id: TurnItemId.make(`evidence:checkpoint:${row}:${run.id}`),
            ordinal: 3,
            type: "checkpoint",
            checkpointId: CheckpointId.make(`evidence:checkpoint:${row}:${run.id}`),
            scopeId: CheckpointScopeId.make(`evidence:scope:${row}:${run.id}`),
            files: [],
          },
        },
        {
          id: EventId.make(`evidence:completed:${row}:${run.id}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...run,
            status: "completed",
            startedAt: run.startedAt ?? now,
            completedAt: now,
          },
        },
      ]);
    });
    const dispatchFollowUp = Effect.fnUntraced(function* (kind: "notification" | "user") {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`evidence:${kind}:${row}`),
        threadId,
        messageId: MessageId.make(`evidence:${kind}:${row}`),
        text:
          kind === "notification"
            ? "Background task finished; no further work is needed."
            : "Summarise what you changed so far.",
        ...(kind === "notification"
          ? {
              notification: {
                source: { kind: "background_task" as const },
                outcome: "completed" as const,
                summary: "Background task finished",
              },
            }
          : {}),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: kind === "notification" ? "agent" : "user",
        creationSource: kind === "notification" ? "provider" : "web",
      });
      return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    });

    if (stage === "init") {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* (yield* ProjectStore.ProjectStoreV2).apply({
        sequence: 0,
        eventId: EventId.make(`evidence:project:${row}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: `Usage-limit evidence ${row}`,
          workspaceRoot: `${home}/workspace-${row}`,
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`evidence:create:${row}`),
        threadId,
        projectId,
        title: values.title ?? `${row} synthetic usage limit`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`evidence:source:${row}`),
        threadId,
        messageId: MessageId.make(`evidence:source:${row}`),
        text: "Work on this.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const resetAt = new Date(
        DateTime.toEpochMillis(now) + Number(values["reset-delay-ms"]),
      ).toISOString();
      yield* write([
        {
          id: EventId.make(`evidence:failed:${row}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...source, status: "failed", completedAt: now },
        },
        {
          id: EventId.make(`evidence:error:${row}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`evidence:error:${row}`),
            type: "error",
            threadId,
            runId: source.id,
            nodeId: source.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: "Usage limit reached",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            failure: { ...failure, resetAt },
          },
        },
      ]);
      if (values["hold-queue"]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`evidence:queue:${row}`),
          threadId,
          messageId: MessageId.make(`evidence:queue:${row}`),
          text: "Run after recovery.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        yield* write([
          {
            id: EventId.make(`evidence:held:${row}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...queued, status: "queued", queuePosition: 1, queueHeld: true },
          },
        ]);
      }
      if (values.arm) {
        const candidate = (yield* projections.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        })).find((c) => c.id === threadId)!;
        const arm = limitRecoveryCommand(candidate, true, DateTime.toEpochMillis(now), false);
        if (arm?.type !== "thread.metadata.update" || !arm.limitRecovery)
          throw new Error("Missing arm");
        yield* orchestrator.autoArmLimitRecovery({
          commandId: arm.commandId,
          threadId,
          limitRecovery: arm.limitRecovery,
        });
      }
      NodeFS.writeFileSync(
        manifestPath,
        JSON.stringify({ row, threadId, sourceRunId: source.id, resetAt }),
      );
    }
    if (stage === "wake") {
      yield* completeRun(yield* dispatchFollowUp("notification"), "No further work is needed.");
    }
    if (stage === "wake-running") {
      const wake = yield* dispatchFollowUp("notification");
      const now = yield* DateTime.now;
      yield* write([
        {
          id: EventId.make(`evidence:running:${row}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...wake, status: "running", startedAt: now, completedAt: null },
        },
      ]);
    }
    if (stage === "finish") {
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      yield* completeRun(runs.at(-1)!, "No further work is needed.");
    }
    if (stage === "user") {
      yield* completeRun(
        yield* dispatchFollowUp("user"),
        "Here is a summary of the changes so far.",
      );
    }
    const shell = (yield* orchestrator.getShellSnapshot()).threads.find((t) => t.id === threadId);
    log("shell", {
      latestRunId: shell?.latestRunId ?? null,
      limitRecovery: shell?.limitRecovery ?? null,
    });
  }).pipe(Effect.provide(layers), Effect.scoped),
);
