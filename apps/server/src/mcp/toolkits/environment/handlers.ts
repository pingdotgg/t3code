import {
  type AppAction,
  AppCommand,
  KeybindingRule,
  OrchestratorMcpFailure,
  ProjectId,
  ClientServerSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
  STATIC_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AppControl from "../../../appControl/AppControl.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { readCaller, threadNotFound, unavailable } from "../../threadAccess.ts";
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

const SETTINGS_KEYS = new Set(Object.keys(ServerSettings.fields));
const PATCH_KEYS = new Set(Object.keys(ClientServerSettingsPatch.fields));
const THEME_KEYS = new Set(
  Object.keys(ServerSettingsPatch.fields).filter((key) => !PATCH_KEYS.has(key)),
);

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const decodePatch = Schema.decodeUnknownEffect(ClientServerSettingsPatch);
const encodeSettings = Schema.encodeEffect(ServerSettings);
const decodeKeybinding = Schema.decodeUnknownEffect(KeybindingRule);
const decodeAppCommand = Schema.decodeUnknownEffect(AppCommand);

const settingsView = (settings: ServerSettings, keys: ReadonlyArray<string> | undefined) =>
  encodeSettings(Settings.redactServerSettingsForClient(settings, { secretReferences: true })).pipe(
    Effect.mapError(unavailable),
    Effect.map((encoded) =>
      keys === undefined
        ? encoded
        : Object.fromEntries(Object.entries(encoded).filter(([key]) => keys.includes(key))),
    ),
  );

/** Whether `next` lets agents use the browser or a device anywhere `current` did not. */
function grantsAgentAccess(current: ServerSettings, next: ServerSettings): boolean {
  const access = (settings: ServerSettings, projectId: ProjectId | null) => {
    const resolved = resolveProjectSettings(settings, projectId).settings;
    return [resolved.enableAgentBrowserAccess, resolved.enableAgentDeviceAccess];
  };
  const projectIds = new Set([
    ...Object.keys(current.projectSettingsOverrides),
    ...Object.keys(next.projectSettingsOverrides),
  ]);
  return [null, ...[...projectIds].map((id) => ProjectId.make(id))].some((projectId) => {
    const before = access(current, projectId);
    return access(next, projectId).some((granted, index) => granted && !before[index]);
  });
}

const keybindingsView = (keybindings: ResolvedKeybindingsConfig) =>
  keybindings.map(Keybindings.keybindingRuleText);

/** Rejects a rule the service would store as a broken entry, as the Settings page path does. */
const validRule = (input: unknown) =>
  decodeKeybinding(input).pipe(
    Effect.mapError((error) => invalid(`Invalid shortcut: ${error.message}`)),
    Effect.filterOrFail(
      (rule) => compileResolvedKeybindingRule(rule) !== null,
      () => invalid("Invalid shortcut: the key or `when` does not parse."),
    ),
  );

/** The listed rule a replace or remove target names, however the agent spelled it. */
const listedRule = (
  keybindings: ResolvedKeybindingsConfig,
  target: { readonly key: string; readonly command: string; readonly when?: string | undefined },
) =>
  Effect.fromNullishOr(
    keybindingsView(keybindings).find((rule) => Keybindings.isSameKeybindingRule(rule, target)),
  ).pipe(Effect.mapError(() => invalid("No such shortcut. `t3_keybindings_read` lists them.")));

const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return {
    ...context,
    descriptor,
    settings: yield* Settings.ServerSettingsService,
    keybindings: yield* Keybindings.Keybindings,
    appControl: yield* AppControl.AppControl,
  };
});

/** Runs an action in the user's window, failing with `refusals` when the window declines it. */
const runInWindow = Effect.fn("EnvironmentTools.runInWindow")(function* (
  appControl: AppControl.AppControl["Service"],
  action: AppAction,
  refusals: Record<"other-environment" | "not-handled", string>,
) {
  const failed = (message: string) =>
    Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message }));
  const result = yield* appControl.run(action).pipe(
    Effect.catchTags({
      AppControlNoWindowError: () =>
        failed("No T3 Code window is open on this environment. Mobile apps don't take commands."),
      AppControlTimeoutError: () =>
        failed(
          "The user's window didn't answer. It may still act when it wakes, so check before retrying.",
        ),
    }),
  );
  if (result !== "ran") return yield* invalid(refusals[result]);
  return { ran: true };
});

/** Runs a write under the caller thread's lock, rechecking access once the lock is held. */
const writeLocked = Effect.fn("EnvironmentTools.writeLocked")(function* <A, R>(
  check: Effect.Effect<unknown, OrchestratorMcpFailure, R>,
  write: Effect.Effect<A, OrchestratorMcpFailure, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  // The turn may have ended, or the thread's modes changed, while this waited for the lock.
  const update = check.pipe(Effect.andThen(write));
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
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
  t3_environment_settings_read: McpToolAccess.reads(({ keys }) =>
    Effect.gen(function* () {
      const unknown = (keys ?? []).filter((key) => !SETTINGS_KEYS.has(key));
      if (unknown.length > 0) return yield* invalid(`Unknown settings: ${unknown.join(", ")}.`);
      const { settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return { settings: yield* settingsView(current, keys) };
    }),
  ),
  t3_environment_settings_update: McpToolAccess.writesEnvironment(({ patch }, check) =>
    Effect.gen(function* () {
      const keys = Object.keys(patch);
      if (keys.length === 0) return yield* invalid("`patch` is empty.");
      const unknown = keys.filter((key) => !PATCH_KEYS.has(key));
      if (unknown.length > 0)
        return yield* invalid(
          `Unknown or read-only settings: ${unknown.join(", ")}.` +
            (unknown.some((key) => THEME_KEYS.has(key)) ? " Use `t3_theme_set` for themes." : ""),
        );
      // Device hosts need the local-host filtering only the RPC path applies.
      if (keys.includes("deviceHosts"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only the user can change deviceHosts, in Settings.",
        });
      const decoded = yield* decodePatch(patch).pipe(
        Effect.mapError((error) => invalid(`Invalid settings: ${error.message}`)),
      );
      return yield* writeLocked(
        check,
        Effect.gen(function* () {
          const { settings } = yield* access;
          const next = yield* settings
            .updateSettings(decoded, (current, patched) =>
              grantsAgentAccess(current, patched)
                ? Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "capability_denied",
                      message:
                        "Only the user can grant agents browser or device access, in Settings.",
                    }),
                  )
                : Effect.void,
            )
            .pipe(Effect.catchTags({ ServerSettingsError: () => Effect.fail(unavailable()) }));
          return { settings: yield* settingsView(next, keys) };
        }),
      );
    }),
  ),
  t3_keybindings_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { keybindings } = yield* access;
      const snapshot = yield* keybindings.getSnapshot.pipe(Effect.mapError(unavailable));
      return {
        keybindings: keybindingsView(snapshot.keybindings),
        commands: [...STATIC_KEYBINDING_COMMANDS],
        issues: snapshot.issues.map((issue) => issue.message),
      };
    }),
  ),
  t3_keybinding_upsert: McpToolAccess.writesEnvironment(({ replace, ...input }, check) =>
    Effect.gen(function* () {
      const rule = yield* validRule(input);
      return yield* writeLocked(
        check,
        Effect.gen(function* () {
          const { keybindings } = yield* access;
          const current = yield* keybindings.getSnapshot.pipe(Effect.mapError(unavailable));
          const target =
            replace === undefined ? undefined : yield* listedRule(current.keybindings, replace);
          const next = yield* keybindings
            .upsertKeybindingRule(target ? { ...rule, replace: target } : rule)
            .pipe(Effect.mapError(unavailable));
          const commands = new Set([rule.command, target?.command]);
          return {
            keybindings: keybindingsView(
              next.keybindings.filter((binding) => commands.has(binding.command)),
            ),
          };
        }),
      );
    }),
  ),
  t3_keybinding_remove: McpToolAccess.writesEnvironment((input, check) =>
    writeLocked(
      check,
      Effect.gen(function* () {
        const { keybindings } = yield* access;
        const current = yield* keybindings.getSnapshot.pipe(Effect.mapError(unavailable));
        const target = yield* listedRule(current.keybindings, input);
        const next = yield* keybindings
          .removeKeybindingRule(target)
          .pipe(Effect.mapError(unavailable));
        return {
          keybindings: keybindingsView(
            next.keybindings.filter((binding) => binding.command === target.command),
          ),
        };
      }),
    ),
  ),
  t3_app_command: McpToolAccess.writesEnvironment(({ command }) =>
    Effect.gen(function* () {
      const appCommand = yield* decodeAppCommand(command).pipe(
        Effect.mapError(() =>
          invalid(
            "Unknown command, or one only the user may run. `t3_keybindings_read` lists them.",
          ),
        ),
      );
      const { appControl } = yield* access;
      return yield* runInWindow(
        appControl,
        { _tag: "command", command: appCommand },
        {
          "other-environment": `\`${command}\` runs only while the user's window shows a thread or draft from this environment.`,
          "not-handled": `Nothing in the user's window handles \`${command}\` right now, such as a thread command outside a thread.`,
        },
      );
    }),
  ),
  t3_app_navigate: McpToolAccess.writesEnvironment(({ to }) =>
    Effect.gen(function* () {
      const { appControl, scope } = yield* access;
      if (to.page === "thread") {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const shell = yield* threads.getThreadShell(to.threadId).pipe(Effect.mapError(unavailable));
        if (shell === null || shell.deletedAt !== null)
          return yield* threadNotFound(
            threads,
            scope,
            to.threadId,
            `Thread ${to.threadId} was not found.`,
          );
      }
      return yield* runInWindow(
        appControl,
        { _tag: "navigate", to },
        {
          "other-environment": "The user's window can't show that page.",
          "not-handled": "The user's window can't show that page.",
        },
      );
    }),
  ),
});
