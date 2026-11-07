import {
  OrchestratorMcpFailure,
  type EnvironmentThemeFile,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Themes from "../../../environmentTheme.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
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
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
const themes = access.pipe(Effect.andThen(Themes.EnvironmentThemeService));
const isThemeLibraryError = Schema.is(Themes.ThemeLibraryError);
const themeFailure = (error: Themes.ThemeLibraryError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });
const lockedEnvironmentWrite = Effect.fn("EnvironmentMcp.lockedWrite")(function* <A, E, R>(
  check: Effect.Effect<void, E, R>,
  operation: Effect.Effect<A, E, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const update = check.pipe(Effect.andThen(operation));
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});
const themeWrite = <P, A>(
  operation: (
    service: Themes.EnvironmentThemeService["Service"],
    input: P,
  ) => Effect.Effect<A, Themes.ThemeLibraryError>,
) =>
  McpToolAccess.writesEnvironment((input: P, check) =>
    lockedEnvironmentWrite(
      check,
      Effect.gen(function* () {
        const service = yield* themes;
        return yield* operation(service, input).pipe(Effect.mapError(themeFailure));
      }),
    ),
  );
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_theme_list: McpToolAccess.reads(() =>
    Effect.flatMap(themes, (service) => service.list).pipe(
      Effect.mapError((error) => (isThemeLibraryError(error) ? themeFailure(error) : error)),
    ),
  ),
  t3_theme_read: McpToolAccess.reads((input: { id: string }) =>
    Effect.flatMap(themes, (service) => service.read(input.id)).pipe(
      Effect.mapError((error) => (isThemeLibraryError(error) ? themeFailure(error) : error)),
    ),
  ),
  t3_theme_create: themeWrite((service, input: { id: string; theme: EnvironmentThemeFile }) =>
    service.save({ ...input, overwrite: false }),
  ),
  t3_theme_update: themeWrite((service, input: { id: string; theme: EnvironmentThemeFile }) =>
    service.save({ ...input, overwrite: true }),
  ),
  t3_theme_duplicate: themeWrite((service, input: { sourceId: string; id: string; name: string }) =>
    service.duplicate(input),
  ),
  t3_theme_delete: themeWrite((service, input: { id: string }) => service.remove(input.id)),
  t3_theme_apply: themeWrite((service, input: { id: string }) => service.setDefault(input.id)),
  t3_theme_clear_default: themeWrite((service) => service.setDefault("")),
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    lockedEnvironmentWrite(
      check,
      Effect.gen(function* () {
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      }),
    ),
  ),
});
