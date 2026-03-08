import type {
  ClientOrchestrationCommand,
  OrchestrationCommand,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { Effect, type FileSystem, type Path } from "effect";
import os from "node:os";

import { createAttachmentId, resolveAttachmentPath } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

export function makeDispatchCommandNormalizer<E>(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly failRouteRequest: (message: string) => Effect.Effect<never, E, never>;
}) {
  const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
    const rawWorkspaceRoot = workspaceRoot.trim();
    const expandedWorkspaceRoot =
      rawWorkspaceRoot === "~"
        ? os.homedir()
        : rawWorkspaceRoot.startsWith("~/") || rawWorkspaceRoot.startsWith("~\\")
          ? input.path.join(os.homedir(), rawWorkspaceRoot.slice(2))
          : rawWorkspaceRoot;
    const normalizedWorkspaceRoot = input.path.resolve(expandedWorkspaceRoot);
    const workspaceStat = yield* input.fileSystem
      .stat(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!workspaceStat) {
      return yield* input.failRouteRequest(
        `Project directory does not exist: ${normalizedWorkspaceRoot}`,
      );
    }
    if (workspaceStat.type !== "Directory") {
      return yield* input.failRouteRequest(
        `Project path is not a directory: ${normalizedWorkspaceRoot}`,
      );
    }
    return normalizedWorkspaceRoot;
  });

  return Effect.fnUntraced(function* (request: {
    readonly command: ClientOrchestrationCommand;
  }) {
    if (request.command.type === "project.create") {
      if (request.command.executionTarget === "ssh-remote") {
        return {
          ...request.command,
          workspaceRoot: request.command.workspaceRoot.trim(),
          remoteHostId: request.command.remoteHostId ?? null,
          remoteHostLabel: request.command.remoteHostLabel ?? null,
        } satisfies OrchestrationCommand;
      }
      return {
        ...request.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(request.command.workspaceRoot),
        remoteHostId: request.command.remoteHostId ?? null,
        remoteHostLabel: request.command.remoteHostLabel ?? null,
      } satisfies OrchestrationCommand;
    }

    if (
      request.command.type === "project.meta.update" &&
      request.command.workspaceRoot !== undefined
    ) {
      if (request.command.executionTarget === "ssh-remote") {
        return {
          ...request.command,
          workspaceRoot: request.command.workspaceRoot.trim(),
        } satisfies OrchestrationCommand;
      }
      return {
        ...request.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(request.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (request.command.type !== "thread.turn.start") {
      return request.command as OrchestrationCommand;
    }

    const turnStartCommand = request.command as Extract<
      ClientOrchestrationCommand,
      { readonly type: "thread.turn.start" }
    >;
    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* input.failRouteRequest(
              `Invalid image attachment payload for '${attachment.name}'.`,
            );
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* input.failRouteRequest(
              `Image attachment '${attachment.name}' is empty or too large.`,
            );
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* input.failRouteRequest("Failed to create a safe attachment id.");
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            stateDir: input.stateDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* input.failRouteRequest(
              `Failed to resolve persisted path for '${attachment.name}'.`,
            );
          }

          yield* input.fileSystem
            .makeDirectory(input.path.dirname(attachmentPath), { recursive: true })
            .pipe(
              Effect.catch(() =>
                input.failRouteRequest(
                  `Failed to create attachment directory for '${attachment.name}'.`,
                ),
              ),
            );
          yield* input.fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.catch(() =>
              input.failRouteRequest(`Failed to persist attachment '${attachment.name}'.`),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...request.command,
      message: {
        ...request.command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
}
