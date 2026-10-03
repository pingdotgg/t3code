import { Effect, FileSystem, Path, Schema } from "effect";
import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationMessageContext,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { consumeCrossThreadDispatchCapability } from "./CrossThreadDispatchCapability.ts";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;

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

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (command.type === "thread.child.report") {
      if (
        command.crossThreadDispatchCapability === undefined ||
        !consumeCrossThreadDispatchCapability(
          command.crossThreadDispatchCapability,
          command.threadId,
        )
      ) {
        return yield* new OrchestrationDispatchCommandError({
          message: "Invalid child report capability.",
        });
      }
      const { crossThreadDispatchCapability: _, ...trustedCommand } = command;
      return trustedCommand satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start" && command.type !== "thread.queued-turn.create") {
      if (command.type === "thread.queued-turn.update" && command.context !== undefined) {
        return {
          ...command,
          context: yield* validateMessageContext(command.context),
        } satisfies OrchestrationCommand;
      }
      return command as OrchestrationCommand;
    }

    const { crossThreadDispatchCapability, ...trustedCommand } = command;
    if (
      command.crossThreadSourceThreadId !== undefined &&
      (crossThreadDispatchCapability === undefined ||
        !consumeCrossThreadDispatchCapability(
          crossThreadDispatchCapability,
          command.crossThreadSourceThreadId,
        ))
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Invalid cross-thread dispatch capability.",
      });
    }

    const normalizedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          // Already-persisted references carry no payload; only dataUrl
          // uploads need decoding and storing on disk.
          if (!("dataUrl" in attachment)) return attachment;
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

          const attachmentId = createAttachmentId(command.threadId);
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

    if (trustedCommand.type === "thread.turn.start") {
      return {
        ...trustedCommand,
        message: {
          ...command.message,
          attachments: normalizedAttachments,
          ...(command.message.context !== undefined
            ? { context: yield* validateMessageContext(command.message.context) }
            : {}),
        },
      } satisfies OrchestrationCommand;
    }

    return {
      ...trustedCommand,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
        ...(command.message.context !== undefined
          ? { context: yield* validateMessageContext(command.message.context) }
          : {}),
      },
    } satisfies OrchestrationCommand;
  });

const decodeMessageContext = Schema.decodeUnknownEffect(OrchestrationMessageContext);

const validateMessageContext = (
  context: unknown,
): Effect.Effect<typeof OrchestrationMessageContext.Type, OrchestrationDispatchCommandError> =>
  decodeMessageContext(context).pipe(
    Effect.mapError(
      () =>
        new OrchestrationDispatchCommandError({
          message:
            "Invalid thread context: records must carry unique, well-formed thread identity.",
        }),
    ),
  );
