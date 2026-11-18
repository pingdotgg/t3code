import {
  CHAT_HISTORY_ARCHIVE_FORMAT,
  ChatHistoryArchive,
  ChatHistoryError,
  CommandId,
  EventId,
  isListedThreadLineage,
  ProjectId,
  type ChatHistoryArchiveProject,
  type ChatHistoryArchiveThread,
  type ChatHistoryExportScope,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

import { createPendingAttachmentId, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { messageEvents } from "./AgentSessionImporter.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

const gzip = NodeUtil.promisify(NodeZlib.gzip);
const gunzip = NodeUtil.promisify(NodeZlib.gunzip);
const decodeArchive = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatHistoryArchive));
const encodeArchive = Schema.encodeEffect(Schema.fromJsonString(ChatHistoryArchive));

const isChatHistoryError = Schema.is(ChatHistoryError);
const exportError = (detail: string) => new ChatHistoryError({ operation: "export", detail });
const importError = (detail: string) => new ChatHistoryError({ operation: "import", detail });

/** The archive's projects and threads for the listed threads in `scope`. */
function selectArchiveThreads<
  TThread extends Pick<OrchestrationV2AppThread, "id" | "projectId" | "lineage" | "deletedAt">,
>(threads: ReadonlyArray<TThread>, scope: ChatHistoryExportScope): TThread[] {
  return threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      (scope.type === "all" ||
        (scope.type === "project" && thread.projectId === scope.projectId) ||
        (scope.type === "thread" && thread.id === scope.threadId)),
  );
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const eventSink = yield* EventSink.EventSinkV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const random = yield* SecureRandom.SecureRandom;

  const exportHistory = Effect.fn("ChatHistoryArchive.export")(
    function* (scope: ChatHistoryExportScope) {
      const ids = scope.type === "thread" ? [scope.threadId] : yield* projections.listThreadIds();
      const records = yield* Effect.forEach(
        ids,
        (threadId) => orchestrator.getThreadRecords(threadId, ["messages"]).pipe(Effect.option),
        { concurrency: 8 },
      );
      const found = records.flatMap((record) => (Option.isSome(record) ? [record.value] : []));
      const selected = new Set(
        selectArchiveThreads(
          found.map((record) => record.thread),
          scope,
        ).map((thread) => thread.id),
      );
      const archiveProjects = new Map<ProjectId, ChatHistoryArchiveProject | null>();
      const threads: ChatHistoryArchiveThread[] = [];
      for (const { thread, messages } of found) {
        if (!selected.has(thread.id)) continue;
        if (!archiveProjects.has(thread.projectId)) {
          const project = yield* projects.getById(thread.projectId);
          const scratch = yield* managedFolders.isScratchProject(thread.projectId);
          archiveProjects.set(
            thread.projectId,
            Option.isNone(project) || scratch
              ? null
              : {
                  key: project.value.id,
                  title: project.value.title,
                  workspaceRoot: project.value.workspaceRoot,
                },
          );
        }
        threads.push({
          id: thread.id,
          projectKey: archiveProjects.get(thread.projectId)?.key ?? null,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: DateTime.formatIso(thread.createdAt),
          updatedAt: DateTime.formatIso(thread.updatedAt),
          archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
          settledAt: thread.settledAt === null ? null : DateTime.formatIso(thread.settledAt),
          messages: messages.flatMap((message) =>
            (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
              ? [
                  {
                    role: message.role,
                    text: message.text,
                    createdAt: DateTime.formatIso(message.createdAt),
                  },
                ]
              : [],
          ),
        });
      }
      if (scope.type !== "all" && threads.length === 0) {
        return yield* exportError("There are no conversations to export.");
      }
      const json = yield* encodeArchive({
        format: CHAT_HISTORY_ARCHIVE_FORMAT,
        version: 1,
        exportedAt: DateTime.formatIso(yield* DateTime.now),
        projects: [...archiveProjects.values()].filter((project) => project !== null),
        threads,
      });
      const bytes = yield* Effect.tryPromise({
        try: () => gzip(json),
        catch: () => exportError("Could not compress the export."),
      });
      // A pending attachment downloads through the attachment asset route and expires in a day.
      const attachmentId = createPendingAttachmentId("gz");
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(path.join(config.attachmentsDir, `${attachmentId}.gz`), bytes);
      const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
      return {
        attachmentId,
        fileName: `t3code-chats-${date}.json.gz`,
        threadCount: threads.length,
      };
    },
    Effect.mapError((cause) =>
      isChatHistoryError(cause) ? cause : exportError("Could not export your conversations."),
    ),
  );

  /** The target project for an archive project: the one in the same folder, or a new one. */
  const resolveProject = Effect.fn("ChatHistoryArchive.resolveProject")(function* (
    project: ChatHistoryArchiveProject,
  ) {
    const existing = yield* projects.getByWorkspaceRoot(project.workspaceRoot);
    if (Option.isSome(existing)) return Option.some(existing.value.id);
    // A folder this machine does not have would leave a project nobody can run in.
    if (!(yield* fileSystem.exists(project.workspaceRoot))) return Option.none<ProjectId>();
    const id = yield* random.uuidV4();
    const created = yield* projects.bootstrap({
      commandId: CommandId.make(`chat-history-import:project:${id}`),
      projectId: ProjectId.make(id),
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    });
    return Option.some(created.project.id);
  });

  const importHistory = Effect.fn("ChatHistoryArchive.import")(
    function* (attachmentId: string) {
      const filePath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
      });
      if (filePath === null) return yield* importError("The uploaded file is no longer available.");
      const raw = yield* fileSystem.readFile(filePath);
      const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
      const text = isGzip
        ? (yield* Effect.tryPromise({
            try: () => gunzip(raw),
            catch: () => importError("The file could not be decompressed."),
          })).toString("utf8")
        : Buffer.from(raw).toString("utf8");
      const archive = yield* decodeArchive(text).pipe(
        Effect.mapError(() => importError("This is not a T3 Code chat export.")),
      );

      const projectIdByKey = new Map<string, ProjectId>();
      for (const project of archive.projects) {
        const resolved = yield* resolveProject(project).pipe(
          Effect.orElseSucceed(() => Option.none<ProjectId>()),
        );
        if (Option.isSome(resolved)) projectIdByKey.set(project.key, resolved.value);
      }
      let scratchProjectId: ProjectId | null = null;
      const projectFor = Effect.fn("ChatHistoryArchive.projectFor")(function* (key: string | null) {
        const mapped = key === null ? undefined : projectIdByKey.get(key);
        if (mapped !== undefined) return mapped;
        scratchProjectId ??= (yield* managedFolders.ensureScratchProject).projectId;
        return scratchProjectId;
      });

      let importedCount = 0;
      let skippedCount = 0;
      for (const thread of archive.threads) {
        const existing = yield* orchestrator
          .getThreadRecords(thread.id, ["messages"])
          .pipe(Effect.option);
        if (Option.isSome(existing)) {
          skippedCount += 1;
          continue;
        }
        const committed = yield* importThread(thread, yield* projectFor(thread.projectKey));
        if (committed) importedCount += 1;
        else skippedCount += 1;
      }
      yield* fileSystem.remove(filePath).pipe(Effect.ignore);
      return { importedCount, skippedCount };
    },
    Effect.mapError((cause) =>
      isChatHistoryError(cause) ? cause : importError("Could not import your conversations."),
    ),
  );

  const importThread = Effect.fn("ChatHistoryArchive.importThread")(
    function* (thread: ChatHistoryArchiveThread, projectId: ProjectId) {
      const createdAt = DateTime.makeUnsafe(thread.createdAt);
      const updatedAt = DateTime.makeUnsafe(thread.updatedAt);
      const settledAt = thread.settledAt === null ? null : DateTime.makeUnsafe(thread.settledAt);
      const appThread: OrchestrationV2AppThread = {
        createdBy: "system",
        creationSource: "server",
        id: thread.id,
        projectId,
        title: thread.title,
        providerInstanceId: thread.modelSelection.instanceId,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: null,
        worktreePath: null,
        linkedPullRequest: null,
        branchPullRequest: null,
        activeProviderThreadId: null,
        // Run-less history: the next turn hands the provider these messages as context.
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.id },
        forkedFrom: null,
        createdAt,
        updatedAt,
        archivedAt: thread.archivedAt === null ? null : DateTime.makeUnsafe(thread.archivedAt),
        settledOverride: settledAt === null ? null : "settled",
        settledAt,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        lastVisitedAt: updatedAt,
        deletedAt: null,
      };
      const committed = yield* eventSink.write({
        events: [
          {
            id: EventId.make(`chat-history-import:thread:${thread.id}:created`),
            type: "thread.created",
            threadId: thread.id,
            providerInstanceId: appThread.providerInstanceId,
            occurredAt: createdAt,
            payload: appThread,
          },
          ...thread.messages.flatMap((message, index) =>
            messageEvents({ threadId: thread.id as ThreadId, index, message }),
          ),
        ],
      });
      return committed.length > 0;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not import a conversation", { cause }).pipe(Effect.as(false)),
    ),
  );

  return { exportHistory, importHistory };
});

export class ChatHistoryArchiveService extends Context.Service<
  ChatHistoryArchiveService,
  Effect.Success<typeof make>
>()("t3/project/ChatHistoryArchive/ChatHistoryArchiveService") {}

export const layer = Layer.effect(ChatHistoryArchiveService, make);
