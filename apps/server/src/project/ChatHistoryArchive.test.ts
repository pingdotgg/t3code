import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CHAT_HISTORY_ARCHIVE_FORMAT,
  ProjectId,
  ThreadId,
  type ChatHistoryArchive,
  type ChatHistoryArchiveThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeZlib from "node:zlib";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { CODEX_MODEL_SELECTION } from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChatHistoryArchiveService from "./ChatHistoryArchive.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("chat-history-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores)));

function archiveThread(id: string): ChatHistoryArchiveThread {
  return {
    id: ThreadId.make(id),
    projectKey: "source-project",
    title: `Chat ${id}`,
    modelSelection: CODEX_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledAt: timestamp,
    messages: [
      { role: "user", text: `Question ${id}`, createdAt: timestamp },
      { role: "assistant", text: `Answer ${id}`, createdAt: timestamp },
    ],
  };
}

const makeArchive = Effect.fn(function* (workspaceRoot: string) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
  const context = yield* Layer.build(
    ChatHistoryArchiveService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
          Layer.succeed(EventSink.EventSinkV2, yield* EventSink.EventSinkV2),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => crypto.getRandomValues(new Uint8Array(size))),
          ),
          ServerConfig.layerTest(workspaceRoot, { prefix: "t3-chat-history-" }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
            getByWorkspaceRoot: (root) =>
              Effect.succeed(root === workspaceRoot ? Option.some(project) : Option.none()),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/unused",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const service = Context.get(context, ChatHistoryArchiveService.ChatHistoryArchiveService);
  const config = Context.get(context, ServerConfig.ServerConfig);
  return { service, attachmentsDir: config.attachmentsDir };
});

const upload = Effect.fn(function* (
  attachmentsDir: string,
  workspaceRoot: string,
  threads: ReadonlyArray<ChatHistoryArchiveThread>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive: ChatHistoryArchive = {
    format: CHAT_HISTORY_ARCHIVE_FORMAT,
    version: 1,
    exportedAt: timestamp,
    projects: [{ key: "source-project", title: "Project", workspaceRoot }],
    threads,
  };
  const attachmentId = createPendingAttachmentId("gz");
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  yield* fs.writeFile(
    path.join(attachmentsDir, `${attachmentId}.gz`),
    NodeZlib.gzipSync(JSON.stringify(archive)),
  );
  return attachmentId;
});

it.effect("adds only the missing chats to an existing project and exports them all", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chat-history-root-" });
    const { service, attachmentsDir } = yield* makeArchive(workspaceRoot);

    const first = yield* upload(attachmentsDir, workspaceRoot, [
      archiveThread("chat-a"),
      archiveThread("chat-b"),
    ]);
    expect(yield* service.importHistory(first)).toEqual({ importedCount: 2, skippedCount: 0 });

    const second = yield* upload(attachmentsDir, workspaceRoot, [
      archiveThread("chat-a"),
      archiveThread("chat-b"),
      archiveThread("chat-c"),
    ]);
    expect(yield* service.importHistory(second)).toEqual({ importedCount: 1, skippedCount: 2 });
    expect(yield* fs.exists(path.join(attachmentsDir, `${second}.gz`))).toBe(false);

    const exported = yield* service.exportHistory({ type: "project", projectId });
    expect(exported.threadCount).toBe(3);
    const bytes = yield* fs.readFile(path.join(attachmentsDir, `${exported.attachmentId}.gz`));
    const archive = JSON.parse(NodeZlib.gunzipSync(bytes).toString("utf8")) as ChatHistoryArchive;
    expect(archive.threads.map((thread) => thread.id).toSorted()).toEqual([
      "chat-a",
      "chat-b",
      "chat-c",
    ]);
    expect(archive.threads.find((thread) => thread.id === "chat-c")?.messages).toEqual(
      archiveThread("chat-c").messages,
    );
    const imported = yield* projections.getThread(ThreadId.make("chat-c"));
    expect(imported.projectId).toBe(projectId);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);
