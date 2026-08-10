import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProjectSourceFolder,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    /**
     * Additional folders each get their own workspace search index, and the
     * indexer scans home and filesystem roots. Indexing `~` or `/` would pin
     * the server, so those are rejected up front rather than at scan time.
     */
    const assertIndexableFolder = (normalizedPath: string) =>
      Effect.gen(function* () {
        if (path.dirname(normalizedPath) === normalizedPath) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Folder '${normalizedPath}' is a filesystem root and cannot be added to a project.`,
          });
        }
        if (normalizedPath === path.resolve(NodeOS.homedir())) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Folder '${normalizedPath}' is the home directory and cannot be added to a project.`,
          });
        }
      });

    const isContainedBy = (candidate: string, ancestor: string) => {
      const relative = path.relative(ancestor, candidate);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };

    /**
     * Normalize a project's additional folders against its primary.
     *
     * Rejects duplicates and folders nested inside one another — either would
     * produce duplicate file-tree entries and an ambiguous path-to-folder
     * attribution downstream.
     *
     * `primary` is `null` on a meta update that leaves `workspaceRoot` alone;
     * the decider re-checks against the stored primary in that case.
     */
    const normalizeAdditionalFolders = (input: {
      readonly primary: string | null;
      readonly folders: ReadonlyArray<ProjectSourceFolder>;
      readonly createIfMissing: boolean;
    }) =>
      Effect.gen(function* () {
        const resolved: Array<ProjectSourceFolder> = [];
        const seen: Array<string> = input.primary === null ? [] : [input.primary];

        for (const folder of input.folders) {
          const normalizedPath = input.createIfMissing
            ? yield* normalizeProjectWorkspaceRootForCreate(folder.path, true)
            : yield* normalizeProjectWorkspaceRoot(folder.path);
          yield* assertIndexableFolder(normalizedPath);

          const key = normalizeProjectPathForComparison(normalizedPath);
          for (const existing of seen) {
            const existingKey = normalizeProjectPathForComparison(existing);
            if (existingKey === key) {
              return yield* new OrchestrationDispatchCommandError({
                message:
                  existing === input.primary
                    ? `Folder '${normalizedPath}' is already this project's primary folder.`
                    : `Folder '${normalizedPath}' is listed more than once for this project.`,
              });
            }
            if (
              isContainedBy(normalizedPath, existing) ||
              isContainedBy(existing, normalizedPath)
            ) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Folder '${normalizedPath}' overlaps '${existing}'. Project folders must not contain one another.`,
              });
            }
          }

          seen.push(normalizedPath);
          resolved.push({
            path: normalizedPath,
            ...(folder.label !== undefined ? { label: folder.label } : {}),
          });
        }

        return resolved as ReadonlyArray<ProjectSourceFolder>;
      });

    if (canonicalCommand.type === "project.create") {
      const workspaceRoot = yield* normalizeProjectWorkspaceRootForCreate(
        canonicalCommand.workspaceRoot,
        canonicalCommand.createWorkspaceRootIfMissing,
      );
      return {
        ...canonicalCommand,
        workspaceRoot,
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
        ...(canonicalCommand.additionalFolders !== undefined
          ? {
              additionalFolders: yield* normalizeAdditionalFolders({
                primary: workspaceRoot,
                folders: canonicalCommand.additionalFolders,
                createIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
              }),
            }
          : {}),
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      (canonicalCommand.workspaceRoot !== undefined ||
        canonicalCommand.additionalFolders !== undefined)
    ) {
      const workspaceRoot =
        canonicalCommand.workspaceRoot !== undefined
          ? yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot)
          : undefined;
      return {
        ...canonicalCommand,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(canonicalCommand.additionalFolders !== undefined
          ? {
              additionalFolders: yield* normalizeAdditionalFolders({
                primary: workspaceRoot ?? null,
                folders: canonicalCommand.additionalFolders,
                createIfMissing: false,
              }),
            }
          : {}),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
