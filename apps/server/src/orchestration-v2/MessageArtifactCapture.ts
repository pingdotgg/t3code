import {
  CommandId,
  MESSAGE_ARTIFACT_MAX_BYTES,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2MessageArtifact,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  findMessageArtifactFences,
  type MessageArtifactFence,
} from "@t3tools/shared/messageArtifacts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  attachmentFileExtension,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { openMediaFile, readMediaFileHeader } from "../assets/MediaFile.ts";
import * as ServerConfig from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/** Copies are stored as text attachments, so the server never serves them as HTML. */
const COPY_FILE_NAME = "artifact.txt";

export class MessageArtifactCaptureError extends Schema.TaggedError<MessageArtifactCaptureError>()(
  "MessageArtifactCaptureError",
  {
    threadId: Schema.String,
    runId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture the artifacts of run ${this.runId}.`;
  }
}

export class MessageArtifactCapture extends Context.Reference<{
  /**
   * Runs `message-artifact.capture` for a run that ended. Copies the files its finished provider
   * replies name into text attachments of the thread and commits them as
   * `message.artifacts-recorded` under a command receipt. A fence whose recorded entry has the same
   * ordinal and path is not copied again, so a later edit to the workspace file cannot change an
   * old reply. Fails on I/O errors that may pass on retry; safe to repeat.
   */
  readonly capture: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, MessageArtifactCaptureError>;
}>("t3/orchestration-v2/MessageArtifactCapture", {
  defaultValue: () => ({ capture: () => Effect.void }),
}) {}

const isInside = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** Node errors that mean the file cannot be captured, as opposed to a read worth retrying. */
const isUncapturableOpenError = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  ["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"].includes(String(cause.code));

/**
 * Reads a bounded HTML file that resolves inside the workspace, or returns null when it cannot be
 * captured. The fence path is checked before any file I/O. Links are resolved with `realPath` and
 * must still land inside the workspace; that check is what holds on Windows, where the open cannot
 * refuse links or avoid blocking the way it does on POSIX.
 */
const readWorkspaceHtmlFile = Effect.fn("MessageArtifactCapture.readWorkspaceHtmlFile")(function* (
  workspaceRoot: string,
  relativePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(workspaceRoot);
  const requested = path.resolve(root, relativePath);
  if (!isInside(path, root, requested)) return null;

  const resolve = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound" || error.reason._tag === "BadResource",
        () => Effect.succeed(null),
      ),
    );
  const canonicalRoot = yield* resolve(root);
  const canonicalPath = yield* resolve(requested);
  if (
    canonicalRoot === null ||
    canonicalPath === null ||
    !isInside(path, canonicalRoot, canonicalPath) ||
    !/\.html?$/iu.test(canonicalPath)
  ) {
    return null;
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* openMediaFile(canonicalPath).pipe(
        Effect.catchIf(
          (error) => isUncapturableOpenError(error.cause),
          () => Effect.succeed(null),
        ),
      );
      if (file === null || file.info.size > BigInt(MESSAGE_ARTIFACT_MAX_BYTES)) return null;
      const bytes = yield* readMediaFileHeader(canonicalPath, file, MESSAGE_ARTIFACT_MAX_BYTES + 1);
      return bytes.byteLength > MESSAGE_ARTIFACT_MAX_BYTES ? null : bytes;
    }),
  );
});

export const live = Layer.effect(
  MessageArtifactCapture,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projections = yield* ProjectionStoreV2;
    const projects = yield* ProjectionProjectRepository;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;

    const copy = Effect.fn("MessageArtifactCapture.copy")(function* (
      threadId: ThreadId,
      messageId: MessageId,
      workspaceRoot: string,
      fence: MessageArtifactFence,
    ) {
      // A file that cannot be captured is left out; its fence stays code.
      const bytes = yield* readWorkspaceHtmlFile(workspaceRoot, fence.path).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (bytes === null || bytes.byteLength === 0) return null;
      // One id per fence, so a retry before the commit overwrites its own file.
      const attachmentId = createDeterministicAttachmentId(
        threadId,
        `${messageId}\n${fence.sourceOrdinal}\n${fence.path}`,
        attachmentFileExtension(COPY_FILE_NAME),
      );
      const destination =
        attachmentId === null
          ? null
          : resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: {
                type: "file",
                id: attachmentId,
                name: COPY_FILE_NAME,
                mimeType: "text/plain",
                sizeBytes: bytes.byteLength,
              },
            });
      if (attachmentId === null || destination === null) return null;
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fileSystem.writeFile(destination, bytes);
      return {
        sourceOrdinal: fence.sourceOrdinal,
        sourcePath: fence.path,
        attachmentId,
      } satisfies OrchestrationV2MessageArtifact;
    });

    // The run's own thread owns the files: a delegated child reads its worktree, not its parent's.
    const workspaceRootOf = (thread: OrchestrationV2AppThread) =>
      thread.worktreePath === null
        ? projects
            .getById({ projectId: thread.projectId })
            .pipe(Effect.map(Option.match({ onNone: () => null, onSome: (p) => p.workspaceRoot })))
        : Effect.succeed(thread.worktreePath);

    const isDeleted = (threadId: ThreadId) =>
      projections.getThread(threadId).pipe(
        Effect.map((thread) => thread.deletedAt !== null),
        Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(true)),
      );

    const execute = Effect.fn("MessageArtifactCapture.capture")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) {
      const projection = yield* projections
        .getThreadProjection(input.threadId)
        .pipe(Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)));
      if (projection === null || projection.thread.deletedAt !== null) return;
      const commandId = CommandId.make(`command:effect:message-artifact.capture:${input.runId}`);
      const capturedAt = yield* DateTime.now;
      let workspaceRoot: string | null | undefined;
      const events: OrchestrationV2DomainEvent[] = [];
      const copiedIds: string[] = [];
      // Only replies a provider finished in this run. Imported history and messages the
      // orchestrator writes, such as a delegated result posted into its parent, never capture.
      for (const message of projection.messages) {
        if (
          message.runId !== input.runId ||
          message.role !== "assistant" ||
          message.creationSource !== "provider" ||
          message.streaming ||
          !message.text.toLowerCase().includes("t3-artifact")
        ) {
          continue;
        }
        const fences = findMessageArtifactFences(message.text).map((fence) => ({
          fence,
          recorded: message.artifacts?.find(
            (entry) =>
              entry.sourceOrdinal === fence.sourceOrdinal && entry.sourcePath === fence.path,
          ),
        }));
        if (fences.every(({ recorded }) => recorded !== undefined)) continue;
        workspaceRoot ??= yield* workspaceRootOf(projection.thread);
        if (workspaceRoot === null) return;
        const root = workspaceRoot;
        const copied = yield* Effect.forEach(fences, ({ fence, recorded }) =>
          recorded === undefined
            ? copy(projection.thread.id, message.id, root, fence)
            : Effect.succeed(null),
        );
        for (const artifact of copied) if (artifact !== null) copiedIds.push(artifact.attachmentId);
        if (copied.every((artifact) => artifact === null)) continue;
        events.push({
          id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
          type: "message.artifacts-recorded",
          threadId: input.threadId,
          runId: input.runId,
          ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
          occurredAt: capturedAt,
          payload: {
            messageId: message.id,
            artifacts: fences.flatMap(({ recorded }, index) => {
              const artifact = recorded ?? copied[index];
              return artifact === undefined || artifact === null ? [] : [artifact];
            }),
          },
        });
      }
      if (events.length === 0) return;
      // A deletion that landed while copying queued cleanup without these copies.
      if (yield* isDeleted(input.threadId)) {
        yield* Effect.forEach(
          copiedIds,
          (attachmentId) => {
            const copyPath = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return copyPath === null ? Effect.void : fileSystem.remove(copyPath, { force: true });
          },
          { discard: true },
        );
        return;
      }
      yield* eventSink.commitCommand({
        commandId,
        threadId: input.threadId,
        commandType: "message-artifact.capture",
        acceptedAt: capturedAt,
        effects: [],
        events,
      });
    });

    return MessageArtifactCapture.of({
      capture: (input) =>
        execute(input).pipe(
          Effect.mapError((cause) => new MessageArtifactCaptureError({ ...input, cause })),
        ),
    });
  }),
);
