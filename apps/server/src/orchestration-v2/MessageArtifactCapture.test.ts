// @effect-diagnostics nodeBuiltinImport:off - directory junctions need Node's symlink type argument.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2MessageArtifact,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { CheckpointRollbackServiceV2 } from "./CheckpointRollbackService.ts";
import { EffectOutboxV2, layer as effectOutboxLayer } from "./EffectOutbox.ts";
import {
  executorLayer,
  layerWithOptions as effectWorkerLayer,
  OrchestrationEffectWorkerV2,
} from "./EffectWorker.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import {
  live as messageArtifactCaptureLive,
  MessageArtifactCapture,
} from "./MessageArtifactCapture.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderTurnControlServiceV2 } from "./ProviderTurnControlService.ts";
import { ProviderTurnStartServiceV2 } from "./ProviderTurnStartService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import { RunFinalizationService } from "./RunFinalizationService.ts";
import { RuntimeRequestServiceV2 } from "./RuntimeRequestService.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { ThreadTitleRegenerationService } from "./ThreadTitleRegenerationService.ts";

const now = DateTime.makeUnsafe("2026-09-10T12:00:00.000Z");
const fence = (path: string) => `\`\`\`t3-artifact\n${path}\n\`\`\``;
const runId = RunId.make("run:message-artifacts");
let nextEventId = 0;
const eventId = () => EventId.make(`event:message-artifacts:${(nextEventId += 1)}`);

const persistence = Layer.mergeAll(
  eventStoreLayer,
  projectionStoreLayer,
  effectOutboxLayer,
  ProjectionProjectRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const platform = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-message-artifacts-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const unusedExecutorServices = Layer.mergeAll(
  Layer.mock(ProviderSessionManagerV2)({}),
  Layer.mock(RunFinalizationService)({}),
  Layer.mock(CheckpointRollbackServiceV2)({}),
  Layer.mock(ProviderTurnControlServiceV2)({}),
  Layer.mock(ProviderTurnStartServiceV2)({}),
  Layer.mock(RuntimeRequestServiceV2)({}),
  Layer.mock(ThreadTitleRegenerationService)({}),
  Layer.mock(ThreadManagementService)({}),
);

/** The event sink and a real outbox worker, so captures run the way run end queues them. */
const services = Layer.mergeAll(
  eventSinkLayer.pipe(Layer.provideMerge(persistence)),
  idAllocatorLayer,
  platform,
);
const capture = messageArtifactCaptureLive.pipe(Layer.provide(services));
const worker = effectWorkerLayer({ workerId: "message-artifacts-test" }).pipe(
  Layer.provide(
    executorLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          unusedExecutorServices,
          ServerSettings.layerTest(),
          capture,
          ResourceCleanupService.live.pipe(
            Layer.provide(Layer.mock(TerminalManager)({})),
            Layer.provide(platform),
          ),
        ),
      ),
    ),
  ),
  Layer.provide(persistence),
);
const TestLayer = () => Layer.mergeAll(services, capture, worker);

/** A capture whose dependencies are replaced by `override`, without the worker. */
const layerWith = <A extends FileSystem.FileSystem | ProjectionStoreV2, E>(
  override: Layer.Layer<A, E>,
) =>
  Layer.mergeAll(
    services,
    messageArtifactCaptureLive.pipe(Layer.provide(override), Layer.provide(services)),
  );

/** Resolving `busy.html` fails the way a file another process holds open does on Windows. */
const busyFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...fileSystem,
      realPath: (path) =>
        path.endsWith("busy.html")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "realPath",
                pathOrDescriptor: path,
              }),
            )
          : fileSystem.realPath(path),
    });
  }),
).pipe(Layer.provide(platform));

/** The thread reads as deleted once copying is done, as if deletion landed meanwhile. */
const deletedWhileCopying = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    return ProjectionStoreV2.of({
      ...projections,
      getThread: (threadId) =>
        projections
          .getThread(threadId)
          .pipe(Effect.map((thread) => ({ ...thread, deletedAt: now }))),
    });
  }),
).pipe(Layer.provide(services));

const createThread = (id: string, worktreePath: string | null) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(id);
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:message-artifacts"),
      title: "Message artifacts",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* (yield* EventSinkV2).write({
      events: [
        { id: eventId(), type: "thread.created", threadId, occurredAt: now, payload: thread },
      ],
    });
    return threadId;
  });

/** Publishes a reply the way providers do: the message and its timeline item, without artifacts. */
const publish = (
  threadId: ThreadId,
  id: string,
  text: string,
  overrides: Partial<
    Pick<OrchestrationV2ConversationMessage, "runId" | "role" | "creationSource" | "streaming">
  > = {},
) =>
  Effect.gen(function* () {
    const messageId = MessageId.make(id);
    const message = {
      createdBy: "agent",
      creationSource: "provider",
      id: messageId,
      threadId,
      runId,
      nodeId: null,
      role: "assistant",
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } satisfies OrchestrationV2ConversationMessage;
    yield* (yield* EventSinkV2).write({
      events: [
        { id: eventId(), type: "message.updated", threadId, occurredAt: now, payload: message },
        {
          id: eventId(),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:${id}`),
            threadId,
            runId: message.runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId,
            text,
            streaming: message.streaming,
          },
        },
      ],
    });
    return messageId;
  });

/** Queues the capture the run end queues and waits for the worker to finish it. */
const captureRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* (yield* EffectOutboxV2).enqueue([
      {
        id: `effect:message-artifact.capture:${runId}`,
        commandId: CommandId.make(`command:effect:message-artifact.capture:${runId}`),
        threadId,
        request: { type: "message-artifact.capture", runId },
      },
    ]);
    yield* (yield* OrchestrationEffectWorkerV2).drain();
  });

const recorded = (threadId: ThreadId, messageId: MessageId) =>
  Effect.gen(function* () {
    const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(threadId);
    const item = projection.turnItems.find(
      (candidate) => candidate.type === "assistant_message" && candidate.messageId === messageId,
    );
    return {
      message: projection.messages.find((message) => message.id === messageId)?.artifacts,
      item: item?.type === "assistant_message" ? item.artifacts : undefined,
    };
  });

/** The stored copy, found the way attachment delivery and cleanup find it. */
const copyPath = (attachmentId: string | undefined) =>
  Effect.map(ServerConfig.ServerConfig, ({ attachmentsDir }) =>
    resolveAttachmentPathById({ attachmentsDir, attachmentId: attachmentId ?? "missing" }),
  );
const readCopy = (attachmentId: string | undefined) =>
  Effect.gen(function* () {
    const path = yield* copyPath(attachmentId);
    return path === null ? null : yield* (yield* FileSystem.FileSystem).readFileString(path);
  });

const makeWorkspace = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-artifact-ws-" });
    for (const [name, contents] of Object.entries(files)) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(workspace, name)), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(workspace, name), contents);
    }
    return workspace;
  });

describe("message artifact capture", () => {
  it.effect("records the run's copies on the message and its turn item under a receipt", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspace = yield* makeWorkspace({ "a.html": "<p>a</p>", "charts/b.html": "<p>b</p>" });
      const threadId = yield* createThread("thread:copies", workspace);
      const messageId = yield* publish(
        threadId,
        "message:copies",
        // The fence info string is case-insensitive.
        ["Intro", fence("a.html"), "Between", "```T3-Artifact\ncharts/b.html\n```"].join("\n"),
      );

      yield* captureRun(threadId);

      const { message, item } = yield* recorded(threadId, messageId);
      assert.deepEqual(
        message?.map(({ sourceOrdinal, sourcePath }) => ({ sourceOrdinal, sourcePath })),
        [
          { sourceOrdinal: 0, sourcePath: "a.html" },
          { sourceOrdinal: 1, sourcePath: "charts/b.html" },
        ],
      );
      assert.deepEqual(item, message);
      assert.equal(yield* readCopy(message?.[0]?.attachmentId), "<p>a</p>");
      assert.equal(yield* readCopy(message?.[1]?.attachmentId), "<p>b</p>");
      const receipts = yield* sql<{ readonly command_type: string }>`
        SELECT command_type FROM orchestration_command_receipts
        WHERE command_id = ${`command:effect:message-artifact.capture:${runId}`}
      `;
      assert.deepEqual(receipts, [{ command_type: "message-artifact.capture" }]);
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect("captures only replies a provider finished in the run", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace({ "chart.html": "chart" });
      const threadId = yield* createThread("thread:excluded", workspace);
      const messageIds = [
        yield* publish(threadId, "message:streaming", fence("chart.html"), { streaming: true }),
        // A delegated result the orchestrator posts into its parent is a server-written user message.
        yield* publish(threadId, "message:delegated", fence("chart.html"), {
          role: "user",
          creationSource: "server",
        }),
        yield* publish(threadId, "message:server", fence("chart.html"), {
          creationSource: "server",
        }),
        yield* publish(threadId, "message:other-run", fence("chart.html"), {
          runId: RunId.make("run:other"),
        }),
        yield* publish(threadId, "message:imported", fence("chart.html"), { runId: null }),
      ];

      yield* captureRun(threadId);

      for (const messageId of messageIds) {
        assert.deepEqual(yield* recorded(threadId, messageId), {
          message: undefined,
          item: undefined,
        });
      }
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect("reuses a recorded copy whose ordinal and path match and copies the rest", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace({ "a.html": "a now", "b.html": "b now" });
      const threadId = yield* createThread("thread:reuse", workspace);
      const messageId = yield* publish(
        threadId,
        "message:reuse",
        [fence("a.html"), fence("b.html")].join("\n"),
      );
      const seeded: OrchestrationV2MessageArtifact[] = [
        { sourceOrdinal: 0, sourcePath: "a.html", attachmentId: "seeded-a" },
        { sourceOrdinal: 1, sourcePath: "renamed.html", attachmentId: "seeded-b" },
      ];
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: eventId(),
            type: "message.artifacts-recorded",
            threadId,
            occurredAt: now,
            payload: { messageId, artifacts: seeded },
          },
        ],
      });

      yield* captureRun(threadId);

      const { message } = yield* recorded(threadId, messageId);
      assert.deepEqual(message?.[0], seeded[0]);
      assert.deepEqual(
        { sourceOrdinal: message?.[1]?.sourceOrdinal, sourcePath: message?.[1]?.sourcePath },
        { sourceOrdinal: 1, sourcePath: "b.html" },
      );
      assert.equal(yield* readCopy(message?.[1]?.attachmentId), "b now");
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect("keeps the recorded copy when the file changes and the reply is re-published", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* makeWorkspace({ "chart.html": "first version" });
      const threadId = yield* createThread("thread:republish", workspace);
      const messageId = yield* publish(threadId, "message:republish", fence("chart.html"));
      yield* captureRun(threadId);
      const first = yield* recorded(threadId, messageId);

      yield* fileSystem.writeFileString(path.join(workspace, "chart.html"), "second version");
      yield* publish(threadId, "message:republish", fence("chart.html"));
      yield* (yield* MessageArtifactCapture).capture({ threadId, runId });

      assert.lengthOf(first.message ?? [], 1);
      assert.deepEqual(yield* recorded(threadId, messageId), first);
      assert.equal(yield* readCopy(first.message?.[0]?.attachmentId), "first version");
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect("reads the workspace of the run's own thread", () =>
    Effect.gen(function* () {
      const parentWorkspace = yield* makeWorkspace({ "chart.html": "parent" });
      const childWorkspace = yield* makeWorkspace({ "chart.html": "child" });
      yield* createThread("thread:parent", parentWorkspace);
      const childThreadId = yield* createThread("thread:child", childWorkspace);
      const messageId = yield* publish(childThreadId, "message:child", fence("chart.html"));

      yield* captureRun(childThreadId);

      const { message } = yield* recorded(childThreadId, messageId);
      assert.equal(yield* readCopy(message?.[0]?.attachmentId), "child");
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect("records only the files it could copy", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace({ "kept.html": "kept" });
      const threadId = yield* createThread("thread:partial", workspace);
      const messageId = yield* publish(
        threadId,
        "message:partial",
        [fence("missing.html"), fence("kept.html")].join("\n"),
      );

      yield* captureRun(threadId);

      const { message } = yield* recorded(threadId, messageId);
      assert.deepEqual(
        message?.map((artifact) => artifact.sourceOrdinal),
        [1],
      );
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect("fails for a read that may pass on retry and records nothing", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace({ "busy.html": "busy", "kept.html": "kept" });
      const threadId = yield* createThread("thread:busy", workspace);
      const messageId = yield* publish(
        threadId,
        "message:busy",
        [fence("kept.html"), fence("busy.html")].join("\n"),
      );

      const exit = yield* Effect.exit((yield* MessageArtifactCapture).capture({ threadId, runId }));

      assert.isTrue(Exit.isFailure(exit));
      assert.isUndefined((yield* recorded(threadId, messageId)).message);
    }).pipe(Effect.provide(layerWith(busyFileSystem))),
  );

  it.effect("removes its copies and records nothing when the thread was deleted meanwhile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const workspace = yield* makeWorkspace({ "chart.html": "chart" });
      const threadId = yield* createThread("thread:deleted", workspace);
      const messageId = yield* publish(threadId, "message:deleted", fence("chart.html"));

      yield* (yield* MessageArtifactCapture).capture({ threadId, runId });

      assert.isUndefined((yield* recorded(threadId, messageId)).message);
      const entries = (yield* fileSystem.exists(attachmentsDir))
        ? yield* fileSystem.readDirectory(attachmentsDir, { recursive: true })
        : [];
      const files = yield* Effect.filter(entries, (entry) =>
        fileSystem
          .stat(`${attachmentsDir}/${entry}`)
          .pipe(Effect.map((info) => info.type === "File")),
      );
      assert.deepEqual(files, []);
    }).pipe(Effect.provide(layerWith(deletedWhileCopying))),
  );

  it.effect("does not read through a directory junction that leaves the workspace", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workspace = yield* makeWorkspace({});
      const outside = yield* makeWorkspace({ "secret.html": "secret" });
      yield* Effect.promise(() =>
        NodeFSP.symlink(outside, path.join(workspace, "linked"), "junction"),
      );
      const threadId = yield* createThread("thread:junction", workspace);
      const messageId = yield* publish(threadId, "message:junction", fence("linked/secret.html"));

      yield* captureRun(threadId);

      assert.isUndefined((yield* recorded(threadId, messageId)).message);
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect.skipIf(!symlinksSupported)("does not follow a file symlink out of the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* makeWorkspace({});
      const outside = yield* makeWorkspace({ "secret.html": "secret" });
      yield* fileSystem.symlink(
        path.join(outside, "secret.html"),
        path.join(workspace, "link.html"),
      );
      const threadId = yield* createThread("thread:symlink", workspace);
      const messageId = yield* publish(threadId, "message:symlink", fence("link.html"));

      yield* captureRun(threadId);

      assert.isUndefined((yield* recorded(threadId, messageId)).message);
    }).pipe(Effect.provide(TestLayer())),
  );

  it.effect("removes recorded copies with the attachment cleanup", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace({ "chart.html": "chart" });
      const threadId = yield* createThread("thread:cleanup", workspace);
      const messageId = yield* publish(threadId, "message:cleanup", fence("chart.html"));
      yield* captureRun(threadId);
      const attachmentIds = ((yield* recorded(threadId, messageId)).message ?? []).map(
        (artifact) => artifact.attachmentId,
      );
      assert.equal(yield* readCopy(attachmentIds[0]), "chart");

      yield* (yield* EffectOutboxV2).enqueue([
        {
          id: "effect:message-artifacts:cleanup",
          commandId: CommandId.make("command:message-artifacts:cleanup"),
          threadId,
          request: { type: "attachment.cleanup", attachmentIds },
        },
      ]);
      yield* (yield* OrchestrationEffectWorkerV2).drain();

      assert.isNull(yield* copyPath(attachmentIds[0]));
    }).pipe(Effect.provide(TestLayer())),
  );
});
