import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as FileSystem from "effect/FileSystem";
import { TestClock } from "effect/testing";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitRegistrationLive } from "../../McpHttpServer.ts";

const callerId = ThreadId.make("caller");
const projectId = ProjectId.make("project");
const createdAt = "2026-09-11T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  threadId: callerId,
  providerSessionId: "test",
  providerInstanceId: modelSelection.instanceId,
  capabilities: new Set(["threads"]),
  issuedAt: 1,
};
function makeLayer(
  db: string,
  wrapQuery = (query: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape) => query,
) {
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(db)),
  );
  return ThreadsToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.effect(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        Effect.map(ProjectionSnapshotQuery.ProjectionSnapshotQuery, wrapQuery),
      ).pipe(Layer.provideMerge(orchestration)),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-tools-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}
const call = Effect.fn("test.callThreadTool")(function* (
  name: string,
  args: Record<string, unknown>,
  invocation = scope,
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});
function result(response: McpSchema.CallToolResult) {
  expect(response.isError).not.toBe(true);
  const content = response.content?.find((entry) => entry.type === "text");
  if (!content || content.type !== "text") throw new Error("Missing MCP text result");
  return JSON.parse(content.text);
}
const seed = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  for (const id of [projectId, ProjectId.make("other-project")]) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(id),
      projectId: id,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      createdAt,
    });
    const threadId = id === projectId ? callerId : ThreadId.make("other-thread");
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(threadId),
      threadId,
      projectId: id,
      title: "Caller",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
  }
});

describe("peer thread MCP", () => {
  it.effect("retries a read when projection changes between shell and detail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-peer-detail-" });
        let detailReads = 0;
        let rename = Effect.void;
        yield* Effect.gen(function* () {
          yield* seed;
          const engine = yield* OrchestrationEngineService;
          rename = engine
            .dispatch({
              type: "thread.meta.update",
              threadId: callerId,
              commandId: CommandId.make("rename-during-read"),
              title: "New title",
            })
            .pipe(Effect.asVoid, Effect.orDie);
          const read = result(yield* call("read_thread", { threadId: callerId }));
          expect(read.thread.title).toBe("New title");
          expect(read.thread.hasPendingApprovals).toBe(false);
          expect(detailReads).toBe(2);
        }).pipe(
          Effect.provide(
            makeLayer(`${directory}/state.sqlite`, (query) => ({
              ...query,
              getThreadDetailSnapshot: (...args) =>
                Effect.gen(function* () {
                  if (++detailReads === 1) yield* rename;
                  return yield* query.getThreadDetailSnapshot(...args);
                }),
            })),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("keeps retry IDs distinct across caller IDs containing delimiters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-peer-retry-" });
        yield* Effect.gen(function* () {
          yield* seed;
          const engine = yield* OrchestrationEngineService;
          const secondCaller = ThreadId.make("caller:b");
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("seed-second-caller"),
            threadId: secondCaller,
            projectId,
            title: "Second caller",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          });
          const first = result(yield* call("create_thread", { title: "First", commandId: "b:c" }));
          const second = result(
            yield* call(
              "create_thread",
              { title: "Second", commandId: "c" },
              { ...scope, threadId: secondCaller },
            ),
          );
          expect(second.threadId).not.toBe(first.threadId);
          expect(
            result(yield* call("read_thread", { threadId: first.threadId })).thread.title,
          ).toBe("First");
          expect(
            result(yield* call("read_thread", { threadId: second.threadId })).thread.title,
          ).toBe("Second");
          expect(
            result(yield* call("create_thread", { title: "First", commandId: "b:c" })),
          ).toEqual(first);
        }).pipe(Effect.provide(makeLayer(`${directory}/state.sqlite`)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect(
    "persists commands across service restart and deduplicates caller retry IDs through MCP",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-peer-persistence-" });
          const db = `${directory}/state.sqlite`;
          const created = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* seed;
              const created = result(
                yield* call("create_thread", { title: "Worker", commandId: "create-worker" }),
              );
              expect(
                result(
                  yield* call("create_thread", { title: "Worker", commandId: "create-worker" }),
                ),
              ).toEqual(created);
              const args = {
                threadId: created.threadId,
                message: "Fix issue",
                commandId: "first-message",
                replyToSource: false,
              };
              const sent = result(yield* call("send_message_to_thread", args));
              expect(result(yield* call("send_message_to_thread", args))).toEqual(sent);
              expect(
                (yield* call("set_thread_settled", { threadId: created.threadId, settled: true }))
                  .isError,
              ).toBe(true);
              const engine = yield* OrchestrationEngineService;
              const timestamp = DateTime.formatIso(yield* DateTime.now);
              for (const status of ["running", "ready"] as const)
                yield* engine.dispatch({
                  type: "thread.session.set",
                  commandId: CommandId.make(`session-${status}`),
                  threadId: ThreadId.make(created.threadId),
                  createdAt: timestamp,
                  session: {
                    threadId: ThreadId.make(created.threadId),
                    status,
                    providerName: "codex",
                    runtimeMode: "full-access",
                    activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
                    lastError: null,
                    updatedAt: timestamp,
                  },
                });
              const completed = result(
                yield* call("wait_threads", {
                  targets: [{ threadId: created.threadId }],
                  timeoutSeconds: 0,
                }),
              );
              expect(completed.timedOut).toBe(false);
              expect(
                result(
                  yield* call("wait_threads", {
                    targets: [{ threadId: created.threadId, cursor: completed.threads[0].cursor }],
                    timeoutSeconds: 0,
                  }),
                ).timedOut,
              ).toBe(true);
              result(
                yield* call("set_thread_settled", { threadId: created.threadId, settled: true }),
              );
              return created;
            }).pipe(Effect.provide(makeLayer(db))),
          );
          // The first scope has closed its SQLite connection and orchestration workers.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const read = result(yield* call("read_thread", { threadId: created.threadId }));
              expect(read.thread.title).toBe("Worker");
              expect(read.thread.settledOverride).toBe("settled");
              expect(read.messages).toHaveLength(1);
              expect(read.messages[0].text).toBe(
                `Message from T3 thread ${callerId}.\n\nFix issue`,
              );
              expect(
                result(
                  yield* call("create_thread", { title: "Worker", commandId: "create-worker" }),
                ),
              ).toEqual(created);
              expect(result(yield* call("list_threads", {})).threads).toHaveLength(2);
              result(
                yield* call("set_thread_settled", { threadId: created.threadId, settled: false }),
              );
              expect(
                result(yield* call("read_thread", { threadId: created.threadId })).thread
                  .settledOverride,
              ).toBe("active");
            }).pipe(Effect.provide(makeLayer(db))),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("rejects cross-project, malformed and null optional arguments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-peer-scope-" });
        yield* Effect.gen(function* () {
          yield* seed;
          for (const [name, args] of [
            ["read_thread", { threadId: "other-thread" }],
            ["send_message_to_thread", { threadId: "other-thread", message: "hello" }],
            ["set_thread_settled", { threadId: "other-thread", settled: true }],
            ["interrupt_thread", { threadId: "other-thread" }],
            ["wait_threads", { targets: [{ threadId: "other-thread" }], timeoutSeconds: 0 }],
          ] as const)
            expect((yield* call(name, args)).isError).toBe(true);
          expect(
            (yield* call("list_threads", {}, { ...scope, capabilities: new Set() })).isError,
          ).toBe(true);
          yield* call("wait_threads", { targets: [], timeoutSeconds: 0 }).pipe(Effect.flip);
          yield* call("read_thread", { threadId: callerId, turnLimit: 101 }).pipe(Effect.flip);
          expect(
            result(
              yield* call("wait_threads", { targets: [{ threadId: callerId }], timeoutSeconds: 0 }),
            ).timedOut,
          ).toBe(true);
          yield* call("create_thread", { title: "Nullable A", commandId: null }).pipe(Effect.flip);
          yield* call("list_threads", { beforeThreadId: null }).pipe(Effect.flip);
        }).pipe(Effect.provide(makeLayer(`${directory}/state.sqlite`)));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect(
    "wait observes new attention requests within one turn without waking on commentary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-peer-attention-" });
          yield* Effect.gen(function* () {
            yield* seed;
            const engine = yield* OrchestrationEngineService;
            const timestamp = DateTime.formatIso(yield* DateTime.now);
            for (const status of ["running", "ready"] as const)
              yield* engine.dispatch({
                type: "thread.session.set",
                commandId: CommandId.make(`initial-${status}`),
                threadId: callerId,
                createdAt: timestamp,
                session: {
                  threadId: callerId,
                  status,
                  providerName: "codex",
                  runtimeMode: "full-access",
                  activeTurnId: status === "running" ? TurnId.make("initial-turn") : null,
                  lastError: null,
                  updatedAt: timestamp,
                },
              });
            yield* TestClock.adjust("1 second");
            result(
              yield* call("send_message_to_thread", {
                threadId: callerId,
                message: "Queued work",
                replyToSource: false,
              }),
            );
            expect(
              result(
                yield* call("wait_threads", {
                  targets: [{ threadId: callerId }],
                  timeoutSeconds: 0,
                }),
              ).timedOut,
            ).toBe(true);
            const append = (id: string, kind: string, requestId: string) =>
              engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(id),
                threadId: callerId,
                createdAt,
                activity: {
                  id: EventId.make(id),
                  kind,
                  summary: kind,
                  tone: "info",
                  createdAt,
                  turnId: TurnId.make("same-turn"),
                  payload: { requestId, requestType: "command" },
                },
              });
            yield* append("request-a", "approval.requested", "a");
            const first = result(
              yield* call("wait_threads", { targets: [{ threadId: callerId }], timeoutSeconds: 0 }),
            );
            expect(first.timedOut).toBe(false);
            yield* append("resolve-a", "approval.resolved", "a");
            yield* append("request-b", "approval.requested", "b");
            const second = result(
              yield* call("wait_threads", {
                targets: [{ threadId: callerId, cursor: first.threads[0].cursor }],
                timeoutSeconds: 0,
              }),
            );
            expect(second.timedOut).toBe(false);
            expect(second.threads[0].cursor).not.toBe(first.threads[0].cursor);
            yield* append("commentary", "tool.started", "unrelated");
            expect(
              result(
                yield* call("wait_threads", {
                  targets: [{ threadId: callerId, cursor: second.threads[0].cursor }],
                  timeoutSeconds: 0,
                }),
              ).timedOut,
            ).toBe(true);
          }).pipe(Effect.provide(makeLayer(`${directory}/state.sqlite`)));
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});
