import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import {
  type ClientOrchestrationCommand,
  type UserInputAttachments,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type IsoDateTime,
  type McpGatewayProfile,
  type OrchestrationCommand,
  type OrchestrationProject,
  type ProviderInstanceId,
  type ServerProvider,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import {
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export function resolveThreadCreateProfile<
  T extends {
    readonly modelSelection?: McpGatewayProfile["modelSelection"] | undefined;
    readonly runtimeMode?: McpGatewayProfile["runtimeMode"] | undefined;
    readonly interactionMode?: McpGatewayProfile["interactionMode"] | undefined;
    readonly profileSelection?:
      | {
          readonly profileId: string;
          readonly revision: number;
          readonly overrideFields: ReadonlyArray<
            "modelSelection" | "runtimeMode" | "interactionMode" | "reasoningEffort"
          >;
        }
      | undefined;
  },
>(
  command: T,
  profiles: ReadonlyArray<McpGatewayProfile>,
  providers: ReadonlyArray<ServerProvider> = [],
): T & { readonly profileSnapshot?: unknown } {
  const selection = command.profileSelection;
  if (selection === undefined) return command;
  const profile = profiles.find((candidate) => candidate.profileId === selection.profileId);
  if (profile === undefined || profile.revision !== selection.revision) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' revision ${selection.revision} is stale or missing.`,
    });
  }
  if (profile.runtimeMode === "read-only") {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' is read-only and cannot create a thread.`,
    });
  }
  const overrides = new Set(selection.overrideFields);
  if (overrides.has("modelSelection") && command.modelSelection === undefined) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' requested a model override without a model selection.`,
    });
  }
  const reasoningEffort = profile.reasoningEffort;
  const readableMatches: ReadonlyArray<NonNullable<McpGatewayProfile["modelSelection"]>> =
    profile.providerLabel === undefined || profile.modelLabel === undefined
      ? []
      : providers.flatMap((provider) => {
          const providerLabel = provider.displayName?.trim() || provider.driver;
          if (
            provider.enabled !== true ||
            provider.availability === "unavailable" ||
            providerLabel !== profile.providerLabel
          ) {
            return [];
          }
          return provider.models
            .filter(
              (model) => model.slug === profile.modelLabel || model.name === profile.modelLabel,
            )
            .map((model) => ({ instanceId: provider.instanceId, model: model.slug }));
        });
  if (readableMatches.length > 1) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' has an ambiguous provider/model selection (${profile.providerLabel} / ${profile.modelLabel}).`,
    });
  }
  const profileModelSelection =
    profile.modelSelection ?? readableMatches[0] ?? command.modelSelection;
  if (profileModelSelection === undefined) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' provider/model is no longer available (${profile.providerLabel ?? "unselected"} / ${profile.modelLabel ?? "unselected"}).`,
    });
  }
  const baseModelSelection =
    overrides.has("modelSelection") && command.modelSelection !== undefined
      ? command.modelSelection
      : profileModelSelection;
  const inheritedOptions = baseModelSelection.options ?? [];
  const modelSelection =
    reasoningEffort === undefined || overrides.has("reasoningEffort")
      ? baseModelSelection
      : {
          ...baseModelSelection,
          options: [
            ...inheritedOptions.filter((option) => option.id !== "reasoningEffort"),
            { id: "reasoningEffort", value: reasoningEffort },
          ],
        };
  const runtimeMode = overrides.has("runtimeMode") ? command.runtimeMode : profile.runtimeMode;
  const interactionMode = overrides.has("interactionMode")
    ? command.interactionMode
    : profile.interactionMode;
  if (runtimeMode === undefined || interactionMode === undefined) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' declared an override without an explicit value.`,
    });
  }
  const source = (
    field: "modelSelection" | "runtimeMode" | "interactionMode" | "reasoningEffort",
  ) => (overrides.has(field) ? ("thread-override" as const) : ("profile" as const));
  return {
    ...command,
    modelSelection,
    runtimeMode,
    interactionMode,
    profileSnapshot: {
      profileId: profile.profileId,
      profileName: profile.name,
      ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
      revision: profile.revision,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      effectiveSource: {
        modelSelection: source("modelSelection"),
        runtimeMode: source("runtimeMode"),
        interactionMode: source("interactionMode"),
        reasoningEffort: source("reasoningEffort"),
      },
    },
  };
}

export function resolveThreadCreateDefaults<
  T extends { readonly projectId: string; readonly modelSelection?: unknown },
>(
  command: T,
  projects: ReadonlyArray<Pick<OrchestrationProject, "id" | "defaultModelSelection">>,
  providers: ReadonlyArray<ServerProvider>,
): T & {
  readonly modelSelection: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  };
} {
  const projectDefault = projects.find(
    (project) => project.id === command.projectId,
  )?.defaultModelSelection;
  if (projectDefault !== undefined && projectDefault !== null) {
    return { ...command, modelSelection: projectDefault };
  }
  const defaultProvider = providers.find(
    (provider) => provider.status === "ready" && provider.models.some((model) => model.isDefault),
  );
  const defaultModel = defaultProvider?.models.find((model) => model.isDefault);
  if (defaultProvider === undefined || defaultModel === undefined) {
    throw new OrchestrationDispatchCommandError({
      message: "No authoritative project or provider default model is available.",
    });
  }
  return {
    ...command,
    modelSelection: {
      instanceId: defaultProvider.instanceId,
      model: defaultModel.slug,
    },
  };
}

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

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

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

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type === "thread.create") {
      if (canonicalCommand.profileSelection === undefined) {
        if (
          canonicalCommand.modelSelection !== undefined &&
          canonicalCommand.useServerDefaults !== true
        ) {
          return { ...canonicalCommand, profileSnapshot: undefined } as OrchestrationCommand;
        }
        const projection = yield* Effect.serviceOption(ProjectionSnapshotQuery);
        const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
        if (Option.isNone(projection) || Option.isNone(providerRegistry)) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Server defaults are unavailable for gateway thread configuration.",
          });
        }
        const [snapshot, providers] = yield* Effect.all([
          projection.value.getCommandReadModel(),
          providerRegistry.value.getProviders,
        ]);
        return yield* Effect.try({
          try: () =>
            resolveThreadCreateDefaults(
              canonicalCommand,
              snapshot.projects,
              providers,
            ) as OrchestrationCommand,
          catch: (cause) =>
            new OrchestrationDispatchCommandError({
              message:
                typeof cause === "object" &&
                cause !== null &&
                "message" in cause &&
                typeof cause.message === "string"
                  ? cause.message
                  : String(cause),
            }),
        });
      }
      const settingsService = yield* Effect.serviceOption(ServerSettingsService);
      const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
      if (Option.isNone(settingsService) || Option.isNone(providerRegistry)) {
        return yield* new OrchestrationDispatchCommandError({
          message:
            "Server settings or provider catalog is unavailable for gateway profile resolution.",
        });
      }
      const [settings, providers] = yield* Effect.all([
        settingsService.value.getSettings,
        providerRegistry.value.getProviders,
      ]);
      return yield* Effect.try({
        try: () =>
          resolveThreadCreateProfile(
            {
              ...canonicalCommand,
              modelSelection: canonicalCommand.modelSelection,
              profileSelection: canonicalCommand.profileSelection,
            },
            settings.mcpGatewayProfiles,
            providers,
          ) as OrchestrationCommand,
        catch: (cause) =>
          new OrchestrationDispatchCommandError({
            message:
              typeof cause === "object" &&
              cause !== null &&
              "message" in cause &&
              typeof cause.message === "string"
                ? cause.message
                : String(cause),
          }),
      });
    }

    if (
      canonicalCommand.type !== "thread.turn.start" &&
      canonicalCommand.type !== "thread.user-input.respond"
    ) {
      return canonicalCommand as OrchestrationCommand;
    }

    const attachments =
      canonicalCommand.type === "thread.turn.start"
        ? canonicalCommand.message.attachments
        : Object.values(canonicalCommand.attachmentsByQuestionId ?? {}).flat();
    if (
      canonicalCommand.type === "thread.user-input.respond" &&
      attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per question response.`,
      });
    }
    const claimedAttachmentPaths: string[] = [];
    const normalizedAttachments = yield* Effect.forEach(
      attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!("dataUrl" in attachment)) {
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: canonicalCommand.threadId,
              attachmentId: attachment.id,
            });
            if (!claim.ok) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            }

            const info = yield* fileSystem.stat(claim.currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );
            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }

            const normalizedAttachment = {
              ...attachment,
              id: claim.finalId,
              mimeType: attachment.mimeType.toLowerCase(),
            };
            const expectedPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: normalizedAttachment,
            });
            if (expectedPath !== claim.finalPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
              });
            }

            // Keep the pending copy until the turn succeeds. A failed thread
            // bootstrap can then retry with a fresh thread id. A copy, not a
            // hard link: an agent editing the delivered file in place must not
            // mutate the retry source.
            yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                    cause,
                  }),
              ),
            );
            claimedAttachmentPaths.push(claim.finalPath);

            return normalizedAttachment;
          }

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
            ...(attachment.source ? { source: attachment.source } : {}),
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
    ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(claimedAttachmentPaths)));

    if (canonicalCommand.type === "thread.user-input.respond") {
      let index = 0;
      const attachmentsByQuestionId = Object.fromEntries(
        Object.entries(canonicalCommand.attachmentsByQuestionId ?? {}).map(
          ([questionId, original]) => {
            const claimed = normalizedAttachments.slice(
              index,
              index + original.length,
            ) as UserInputAttachments[string];
            index += original.length;
            return [questionId, claimed];
          },
        ),
      );
      return {
        ...canonicalCommand,
        ...(attachments.length > 0 ? { attachmentsByQuestionId } : {}),
      };
    }
    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  const originalAttachments =
    command.type === "thread.turn.start"
      ? command.message.attachments
      : command.type === "thread.user-input.respond"
        ? Object.values(command.attachmentsByQuestionId ?? {}).flat()
        : [];
  const normalizedAttachments =
    normalizedCommand.type === "thread.turn.start"
      ? normalizedCommand.message.attachments
      : normalizedCommand.type === "thread.user-input.respond"
        ? Object.values(normalizedCommand.attachmentsByQuestionId ?? {}).flat()
        : [];
  if (normalizedAttachments.length === 0) return;

  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedAttachments.entries()) {
    const original = originalAttachments[index];
    if (
      !original ||
      "dataUrl" in original ||
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }
  yield* removeClaimedAttachmentPaths(claimedPaths);
});
