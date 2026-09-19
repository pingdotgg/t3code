import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { readCaller, readMutationCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = (writable = false) =>
  Effect.gen(function* () {
    const context = yield* writable ? readMutationCaller() : readCaller();
    const environment = yield* Environment.ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId !== context.scope.environmentId)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential belongs to another environment.",
      });
    return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
  });
export const EnvironmentHandlersLive = EnvironmentToolkit.toLayer({
  t3_environment_read: () =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access();
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  t3_environment_preferences_update: (patch) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      return yield* executor.withLock(
        scope.threadId,
        Effect.gen(function* () {
          const { caller, settings } = yield* access(true);
          if (
            caller.archivedAt !== null ||
            caller.runtimeMode !== "full-access" ||
            caller.interactionMode !== "default"
          )
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Preference updates require a live full-access/default thread.",
            });
          return preferences(
            yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
          );
        }),
      );
    }),
});
