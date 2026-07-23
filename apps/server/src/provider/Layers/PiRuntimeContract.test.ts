// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../../orchestration/Services/ProviderRuntimeIngestion.ts";
import { type ProviderAdapterError, ProviderUnsupportedError } from "../Errors.ts";
import type {
  PiSessionRuntimeOptions,
  PiSessionRuntimeShape,
} from "../Drivers/PiSessionRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";

const PI = ProviderDriverKind.make("pi");
const INSTANCE = ProviderInstanceId.make("pi_contract");
const THREAD = ThreadId.make("thread-pi-contract");
const PROJECT = ProjectId.make("project-pi-contract");

const makeControlledPiRuntime = Effect.fn("makeControlledPiRuntime")(function* () {
  const events = yield* PubSub.unbounded<unknown>();
  const prompts: Array<{
    readonly message: string;
    readonly images?:
      | ReadonlyArray<{
          readonly type: "image";
          readonly data: string;
          readonly mimeType: string;
        }>
      | undefined;
    readonly streamingBehavior?: "steer" | "followUp" | undefined;
  }> = [];
  const runtimeOptions: PiSessionRuntimeOptions[] = [];
  let aborts = 0;

  const factory = (options: PiSessionRuntimeOptions) => {
    runtimeOptions.push(options);
    const sessionId = options.sessionId ?? THREAD;
    const sessionFile = options.sessionDirectory
      ? NodePath.join(options.sessionDirectory, `${sessionId}.jsonl`)
      : `/tmp/${sessionId}.jsonl`;
    return Effect.succeed({
      start: () =>
        Effect.succeed({
          sessionId,
          sessionFile,
          model: { provider: "custom", id: "team/coder", name: "Team Coder" },
        }),
      getState: () =>
        Effect.succeed({
          sessionId: THREAD,
          model: { provider: "custom", id: "team/coder", name: "Team Coder" },
        }),
      getAvailableModels: () => Effect.succeed([]),
      setModel: () => Effect.void,
      getAvailableThinkingLevels: () => Effect.succeed(["off", "high"]),
      setThinkingLevel: () => Effect.void,
      prompt: (input) =>
        Effect.sync(() => {
          prompts.push(input);
          if (options.sessionDirectory) {
            NodeFS.mkdirSync(options.sessionDirectory, { recursive: true });
            NodeFS.writeFileSync(sessionFile, `session ${sessionId} ${input.message}\n`);
          }
        }),
      abort: () =>
        Effect.sync(() => {
          aborts += 1;
        }),
      events: Stream.fromPubSub(events),
      close: Effect.void,
    } satisfies PiSessionRuntimeShape);
  };

  return {
    factory,
    runtimeOptions,
    prompts,
    emit: (event: unknown) => PubSub.publish(events, event).pipe(Effect.asVoid),
    abortCount: () => aborts,
  };
});

function makeRegistry(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): ProviderAdapterRegistryShape {
  const unsupported = () => new ProviderUnsupportedError({ provider: INSTANCE });
  return {
    getByInstance: (instanceId) =>
      instanceId === INSTANCE ? Effect.succeed(adapter) : Effect.fail(unsupported()),
    getInstanceInfo: (instanceId) =>
      instanceId === INSTANCE
        ? Effect.succeed({
            instanceId: INSTANCE,
            driverKind: PI,
            displayName: "Pi contract",
            enabled: true,
            continuationIdentity: {
              driverKind: PI,
              continuationKey: `pi:instance:${INSTANCE}`,
            },
          })
        : Effect.fail(unsupported()),
    listInstances: () => Effect.succeed([INSTANCE]),
    listProviders: () => Effect.succeed([PI]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  };
}

function makeContractLayer(adapter: ProviderAdapterShape<ProviderAdapterError>) {
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry, makeRegistry(adapter))),
    Layer.provide(directoryLayer),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const snapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );

  return ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(snapshotLayer),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
}

const drainRuntime = Effect.fn("drainRuntime")(function* (
  ingestion: ProviderRuntimeIngestionService["Service"],
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    yield* Effect.yieldNow;
    yield* ingestion.drain;
  }
});

describe("Pi runtime contract", () => {
  it.effect(
    "projects native Pi prompt, work-log, image, and abort behavior through ProviderService",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const controlled = yield* makeControlledPiRuntime();
          const nativeSessionsRoot = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "t3-pi-contract-sessions-"),
          );
          const sessionDirectory = NodePath.join(nativeSessionsRoot, String(INSTANCE));
          const siblingInstanceDirectory = NodePath.join(nativeSessionsRoot, "pi_other");
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              NodeFS.rmSync(nativeSessionsRoot, { recursive: true, force: true });
            }),
          );
          const adapter = yield* makePiAdapter(
            { enabled: true, binaryPath: "pi", configDirectory: "", launchArgs: "" },
            {
              instanceId: INSTANCE,
              sessionDirectory,
              loadImageAttachment: (attachment) =>
                Effect.succeed({
                  type: "image",
                  data: `base64:${attachment.id}`,
                  mimeType: attachment.mimeType,
                }),
              makeRuntime: controlled.factory,
            },
          );
          const workspaceRoot = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "t3-pi-contract-"),
          );
          NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              NodeFS.rmSync(workspaceRoot, { recursive: true, force: true });
            }),
          );

          const services = yield* Layer.build(makeContractLayer(adapter));
          return yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const snapshots = yield* ProjectionSnapshotQuery;
            const ingestion = yield* ProviderRuntimeIngestionService;
            const provider = yield* ProviderService;
            yield* ingestion.start();

            const createdAt = "2026-01-01T00:00:00.000Z";
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("cmd-pi-contract-project"),
              projectId: PROJECT,
              title: "Pi contract project",
              workspaceRoot,
              defaultModelSelection: { instanceId: INSTANCE, model: "custom/team%2Fcoder" },
              createdAt,
            });
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("cmd-pi-contract-thread"),
              threadId: THREAD,
              projectId: PROJECT,
              title: "Pi contract thread",
              modelSelection: { instanceId: INSTANCE, model: "custom/team%2Fcoder" },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt,
            });
            yield* provider.startSession(THREAD, {
              threadId: THREAD,
              provider: PI,
              providerInstanceId: INSTANCE,
              cwd: workspaceRoot,
              runtimeMode: "full-access",
              modelSelection: { instanceId: INSTANCE, model: "custom/team%2Fcoder" },
            });
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("cmd-pi-contract-session"),
              threadId: THREAD,
              session: {
                threadId: THREAD,
                status: "ready",
                providerName: PI,
                providerInstanceId: INSTANCE,
                runtimeMode: "full-access",
                activeTurnId: null,
                updatedAt: createdAt,
                lastError: null,
              },
              createdAt,
            });

            yield* Effect.yieldNow;
            const firstTurn = yield* provider.sendTurn({
              threadId: THREAD,
              input: "Inspect this screenshot and report the repository status.",
              attachments: [
                {
                  type: "image",
                  id: "thread-pi-contract-550e8400-e29b-41d4-a716-446655440000",
                  name: "status.png",
                  mimeType: "image/png",
                  sizeBytes: 12,
                },
              ],
            });
            expect(controlled.prompts).toEqual([
              {
                message: "Inspect this screenshot and report the repository status.",
                images: [
                  {
                    type: "image",
                    data: "base64:thread-pi-contract-550e8400-e29b-41d4-a716-446655440000",
                    mimeType: "image/png",
                  },
                ],
              },
            ]);
            expect(controlled.runtimeOptions).toEqual([
              expect.objectContaining({
                sessionId: THREAD,
                sessionDirectory,
              }),
            ]);
            const nativeSessionFile = NodePath.join(sessionDirectory, `${THREAD}.jsonl`);
            expect(NodeFS.existsSync(nativeSessionFile)).toBe(true);
            expect(NodeFS.readFileSync(nativeSessionFile, "utf8")).toContain(THREAD);
            expect(
              NodeFS.existsSync(NodePath.join(siblingInstanceDirectory, `${THREAD}.jsonl`)),
            ).toBe(false);

            yield* controlled.emit({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
            });
            yield* controlled.emit({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: {
                type: "thinking_delta",
                contentIndex: 0,
                delta: "Checking the repository before responding.",
              },
            });
            yield* controlled.emit({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
            });
            yield* controlled.emit({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: {
                type: "toolcall_start",
                contentIndex: 1,
                id: "call-status",
                toolName: "bash",
              },
            });
            yield* controlled.emit({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: {
                type: "toolcall_delta",
                contentIndex: 1,
                delta: '{"command":"git status --short"}',
              },
            });
            yield* controlled.emit({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: {
                type: "toolcall_end",
                contentIndex: 1,
                toolCall: {
                  type: "toolCall",
                  id: "call-status",
                  name: "bash",
                  arguments: { command: "git status --short" },
                },
              },
            });
            yield* controlled.emit({
              type: "tool_execution_start",
              toolCallId: "call-status",
              toolName: "bash",
              args: { command: "git status --short" },
            });
            yield* controlled.emit({
              type: "tool_execution_update",
              toolCallId: "call-status",
              toolName: "bash",
              args: { command: "git status --short" },
              partialResult: { content: [{ type: "text", text: "M package.json" }] },
            });
            yield* controlled.emit({
              type: "tool_execution_end",
              toolCallId: "call-status",
              toolName: "bash",
              result: { content: [{ type: "text", text: "M package.json" }] },
              isError: false,
            });
            yield* controlled.emit({
              type: "queue_update",
              steering: ["Focus on tests"],
              followUp: [],
            });
            yield* controlled.emit({ type: "compaction_start", reason: "threshold" });
            yield* controlled.emit({
              type: "compaction_end",
              reason: "threshold",
              result: { summary: "Condensed earlier context" },
              aborted: false,
              willRetry: false,
            });
            yield* controlled.emit({
              type: "auto_retry_start",
              attempt: 1,
              maxAttempts: 3,
              delayMs: 1,
              errorMessage: "Temporary overload",
            });
            yield* controlled.emit({ type: "auto_retry_end", success: true, attempt: 1 });
            yield* controlled.emit({ type: "queue_update", steering: [], followUp: [] });
            yield* controlled.emit({ type: "message_start", message: { role: "assistant" } });
            yield* controlled.emit({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: "Repository is clean.",
              },
            });
            yield* controlled.emit({ type: "message_end", message: { role: "assistant" } });
            yield* controlled.emit({ type: "agent_settled" });
            yield* drainRuntime(ingestion);

            let snapshot = yield* snapshots.getSnapshot();
            let thread = snapshot.threads.find((entry) => entry.id === THREAD);
            expect(thread?.messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "assistant",
                  turnId: firstTurn.turnId,
                  text: "Repository is clean.",
                }),
              ]),
            );
            expect(thread?.activities).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ kind: "task.progress", summary: "Thinking" }),
                expect.objectContaining({ kind: "tool.updated", summary: "bash" }),
                expect.objectContaining({ kind: "tool.completed", summary: "bash" }),
                expect.objectContaining({
                  kind: "context-compaction",
                  summary: "Context compacted",
                }),
                expect.objectContaining({ kind: "task.progress", summary: "Queued work" }),
                expect.objectContaining({ kind: "task.progress", summary: "Retrying Pi request" }),
              ]),
            );
            expect(thread?.session).toMatchObject({ status: "ready", activeTurnId: null });

            const interrupted = yield* provider.sendTurn({
              threadId: THREAD,
              input: "Start another task and stop it.",
              attachments: [],
            });
            yield* provider.interruptTurn({ threadId: THREAD, turnId: interrupted.turnId });
            yield* controlled.emit({ type: "agent_settled" });
            yield* drainRuntime(ingestion);

            snapshot = yield* snapshots.getSnapshot();
            thread = snapshot.threads.find((entry) => entry.id === THREAD);
            expect(controlled.abortCount()).toBe(1);
            expect(thread?.session).toMatchObject({ status: "ready", activeTurnId: null });
            expect(interrupted.turnId).toBeTruthy();
          }).pipe(Effect.provide(services));
        }),
      ),
  );
});
