import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals([
      "terminal",
      "preview",
      "attachment",
      "thread-attachments",
      "scheduled-tasks",
    ]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
  /** Removes a deleted thread's fork family's files once no member is live; idempotent. */
  readonly cleanupThreadAttachments: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
    cleanupThreadAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const cleanupAttachments = Effect.fn("ResourceCleanupService.cleanupAttachments")(function (
      attachmentIds: ReadonlyArray<string>,
    ) {
      return Effect.forEach(
        attachmentIds,
        (attachmentId) => {
          const extension = parseAttachmentFileExtension(attachmentId);
          const path =
            resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            }) ??
            (extension
              ? resolveAttachmentRelativePath({
                  attachmentsDir: config.attachmentsDir,
                  relativePath: `${attachmentId}.${extension}`,
                })
              : null);
          return path === null
            ? Effect.void
            : fileSystem.remove(path, { force: true }).pipe(
                Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true })),
                Effect.mapError(
                  (cause) =>
                    new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                ),
              );
        },
        { discard: true, concurrency: 4 },
      );
    });
    return {
      cleanupScheduledTasks: Effect.fn("ResourceCleanupService.cleanupScheduledTasks")(function (
        threadId: ThreadId,
      ) {
        return scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          );
      }),
      cleanupTerminals: Effect.fn("ResourceCleanupService.cleanupTerminals")(function (
        threadId: string,
      ) {
        return terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          );
      }),
      cleanupPreviews: Effect.fn("ResourceCleanupService.cleanupPreviews")(function (
        threadId: string,
      ) {
        return previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          );
      }),
      cleanupAttachments,
      cleanupThreadAttachments: Effect.fn("ResourceCleanupService.cleanupThreadAttachments")(
        function* (threadId: ThreadId) {
          const attachmentIds = yield* projections
            .getDeletableAttachmentIds(threadId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ResourceCleanupError({ operation: "thread-attachments", threadId, cause }),
              ),
            );
          yield* cleanupAttachments(attachmentIds);
        },
      ),
    };
  }),
);
