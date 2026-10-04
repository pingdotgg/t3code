import {
  type CustomModelSetting,
  type KeybindingWhenNode,
  OrchestratorMcpFailure,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ResolvedKeybindingsConfig,
  ServerRemoveKeybindingInput,
  ServerSettings,
  ServerSettingsPatch,
  ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readCaller, readFullAccessCaller, unavailable } from "../../threadAccess.ts";
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

// The settings service's own redaction marker.
const SECRET_MARKER = "•".repeat(6);
// Provider form fields with a "password" control. Clients receive them in plain text; agents do not.
const PLAINTEXT_SECRET_KEYS = new Set(["apiKey", "serverPassword"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const mapRecord = (value: unknown, f: (entry: unknown) => unknown) =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, f(v)])) : value;
const encodeSettings = Schema.encodeEffect(ServerSettings);

/** Full server settings as JSON with every credential redacted. */
export const mcpSettings = (settings: ServerSettings) =>
  encodeSettings(Settings.redactServerSettingsForClient(settings)).pipe(
    Effect.map((encoded) => ({
      ...encoded,
      providers: mapRecord(encoded.providers, redactSecretFields),
      // Instance configs are opaque driver data that can nest credentials anywhere; only the
      // custom models this tool can change are returned.
      providerInstances: mapRecord(encoded.providerInstances, (instance) =>
        isRecord(instance) && "config" in instance
          ? {
              ...instance,
              config:
                isRecord(instance.config) && Array.isArray(instance.config.customModels)
                  ? { customModels: instance.config.customModels }
                  : {},
            }
          : instance,
      ),
    })),
    Effect.mapError(unavailable),
  );
function redactSecretFields(config: unknown) {
  if (!isRecord(config)) return config;
  return Object.fromEntries(
    Object.entries(config).map(([key, field]) => [
      key,
      PLAINTEXT_SECRET_KEYS.has(key) && typeof field === "string" && field.length > 0
        ? SECRET_MARKER
        : field,
    ]),
  );
}

// Credentials, and the maps that carry them, stay in the Settings UI. deviceHosts needs the SSH
// host preparation ws.ts runs before saving.
const REJECTED_PATCH_KEYS = [
  "bitbucket",
  "usageLimitSources",
  "cursorKeychainUsageEnabled",
  "providerInstances",
  "deviceHosts",
] as const;
function rejectedPatchKeys(patch: ServerSettingsPatch) {
  return [
    ...REJECTED_PATCH_KEYS.filter((key) => patch[key] !== undefined),
    ...(patch.providers?.antigravity?.apiKey === undefined ? [] : ["providers.antigravity.apiKey"]),
    ...(patch.providers?.opencode?.serverPassword === undefined
      ? []
      : ["providers.opencode.serverPassword"]),
  ];
}
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: message.slice(0, 2_000) });
const strict = { onExcessProperty: "error" } as const;
const invalidInput = (label: string) => (error: Schema.SchemaError) =>
  invalid(`Invalid ${label}: ${error.message}`);
const decodePatch = (input: unknown) =>
  Schema.decodeUnknownEffect(ServerSettingsPatch)(input, strict).pipe(
    Effect.mapError(invalidInput("settings")),
  );
const withoutNullWhen = <T extends { readonly when?: string | null | undefined }>({
  when,
  ...rest
}: T) => (when === null || when === undefined ? rest : { ...rest, when });
const decodeUpsert = (input: unknown) =>
  Schema.decodeUnknownEffect(ServerUpsertKeybindingInput)(input, strict).pipe(
    Effect.mapError(invalidInput("keybinding")),
  );
const decodeRemove = (input: unknown) =>
  Schema.decodeUnknownEffect(ServerRemoveKeybindingInput)(input, strict).pipe(
    Effect.mapError(invalidInput("keybinding")),
  );

const keybindingFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The keybindings file could not be read or written.",
  });
// The Settings UI's when text; the keybindings service matches when by meaning, so a listed
// rule can be removed by the same text.
function whenText(node: KeybindingWhenNode): string {
  const wrap = (child: KeybindingWhenNode) =>
    child.type === "identifier" || child.type === "not" || child.type === node.type
      ? whenText(child)
      : `(${whenText(child)})`;
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrap(node.node)}`;
    case "and":
      return `${wrap(node.left)} && ${wrap(node.right)}`;
    case "or":
      return `${wrap(node.left)} || ${wrap(node.right)}`;
  }
}
const encodeKeybinding = Schema.encodeExit(Keybindings.ResolvedKeybindingFromConfig);
function keybindingTexts(rules: ResolvedKeybindingsConfig) {
  return rules.flatMap((rule) => {
    const encoded = encodeKeybinding(rule);
    return Exit.isSuccess(encoded)
      ? [
          {
            key: encoded.value.key,
            command: rule.command,
            when: rule.whenAst ? whenText(rule.whenAst) : null,
          },
        ]
      : [];
  });
}

/**
 * Enable/disable or replace custom models on one instance. An explicit instance entry is
 * upserted whole, as the Settings UI does; a built-in default instance lives in `providers`.
 */
interface InstanceChange {
  readonly mutation?: ProviderInstanceMutation;
  readonly patch: ServerSettingsPatch;
}
function providerInstanceChange(
  current: ServerSettings,
  change: {
    readonly instanceId: ProviderInstanceId;
    readonly enabled?: boolean | undefined;
    readonly customModels?: ReadonlyArray<CustomModelSetting> | undefined;
  },
): Effect.Effect<InstanceChange, OrchestratorMcpFailure> {
  const enabled = change.enabled === undefined ? {} : { enabled: change.enabled };
  const instance = current.providerInstances[change.instanceId];
  if (instance !== undefined) {
    if (change.customModels !== undefined && !isRecord(instance.config))
      return Effect.fail(
        invalid("This instance's config is not an object; change its models in the Settings UI."),
      );
    const config = isRecord(instance.config) ? instance.config : {};
    const mutation: ProviderInstanceMutation = {
      operation: "upsert",
      instanceId: change.instanceId,
      instance: {
        ...instance,
        ...enabled,
        ...(change.customModels === undefined
          ? {}
          : { config: { ...config, customModels: change.customModels } }),
      },
    };
    return Effect.succeed({ mutation, patch: {} });
  }
  if (Object.hasOwn(current.providers, change.instanceId)) {
    const fields = {
      ...enabled,
      ...(change.customModels === undefined ? {} : { customModels: change.customModels }),
    };
    // Every legacy driver patch takes enabled and customModels.
    return Effect.succeed({
      patch: { providers: { [change.instanceId]: fields } } as ServerSettingsPatch,
    });
  }
  return Effect.fail(invalid("The provider instance was not found."));
}

const access = (fullAccessMessage?: string) =>
  Effect.gen(function* () {
    const context = yield* fullAccessMessage === undefined
      ? readCaller()
      : readFullAccessCaller(fullAccessMessage);
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
  t3_environment_read: ({ include = [] }) =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access(
        include.includes("settings")
          ? "Full settings include host paths and require a live full-access/default calling thread or a full-access client."
          : undefined,
      );
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const keybindings = include.includes("keybindings")
        ? yield* (yield* Keybindings.Keybindings).loadConfigState.pipe(
            Effect.mapError(keybindingFailure),
          )
        : undefined;
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        ...(include.includes("settings") ? { settings: yield* mcpSettings(current) } : {}),
        ...(keybindings ? { keybindings: keybindingTexts(keybindings.keybindings) } : {}),
      };
    }),
  t3_environment_preferences_update: ({
    settings: settingsInput,
    providerInstance,
    keybinding,
    ...fields
  }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        const { settings } = yield* access(
          "Preference updates require a live full-access/default thread or a full-access client.",
        );
        // Validate everything before the first write.
        const extra = settingsInput === undefined ? {} : yield* decodePatch(settingsInput);
        const rejected = rejectedPatchKeys(extra);
        if (rejected.length > 0)
          return yield* invalid(
            `These settings hold or carry credentials and can only be changed in the Settings UI: ${rejected.join(", ")}.`,
          );
        const duplicated = Object.keys(fields).filter((key) => Object.hasOwn(extra, key));
        if (duplicated.length > 0)
          return yield* invalid(
            `Pass ${duplicated.join(", ")} at the top level or inside settings, not both.`,
          );
        if (providerInstance && extra.providers)
          return yield* invalid("Pass providerInstance or settings.providers, not both.");
        const { action, ...listed } = keybinding ?? { action: undefined };
        // Listed rules carry when: null; the keybinding contracts expect it omitted.
        const rule = {
          ...withoutNullWhen(listed),
          ...("replace" in listed && listed.replace
            ? { replace: withoutNullWhen(listed.replace) }
            : {}),
        };
        const keybindingInput =
          action === "upsert"
            ? yield* decodeUpsert(rule)
            : action === "remove"
              ? yield* decodeRemove(rule)
              : undefined;
        const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
        const instanceChange: InstanceChange =
          providerInstance === undefined
            ? { patch: {} }
            : yield* providerInstanceChange(current, providerInstance);
        const patch: ServerSettingsPatch = { ...extra, ...instanceChange.patch, ...fields };
        // Settings and keybindings persist separately, so one call changes one of them.
        if (
          keybinding !== undefined &&
          (instanceChange.mutation !== undefined || Object.keys(patch).length > 0)
        )
          return yield* invalid("Change settings and a keybinding in separate calls.");

        let next = current;
        if (
          instanceChange.mutation !== undefined ||
          Object.keys(patch).length > 0 ||
          keybinding === undefined
        )
          next = yield* (
            instanceChange.mutation === undefined
              ? settings.updateSettings(patch)
              : settings.updateProviderInstance(instanceChange.mutation, patch)
          ).pipe(Effect.mapError(unavailable));
        const keybindingService = yield* Keybindings.Keybindings;
        const keybindings =
          keybindingInput === undefined
            ? undefined
            : yield* (
                action === "upsert"
                  ? keybindingService.upsertKeybindingRule(keybindingInput)
                  : keybindingService.removeKeybindingRule(keybindingInput)
              ).pipe(Effect.mapError(keybindingFailure));
        return {
          ...preferences(next),
          updated: [
            ...Object.keys({ ...extra, ...fields }),
            ...(providerInstance ? [`providerInstance:${providerInstance.instanceId}`] : []),
            ...(action ? [`keybinding:${action}`] : []),
          ],
          ...(keybindings && keybindingInput
            ? {
                keybindings: keybindingTexts(
                  keybindings.filter((entry) => entry.command === keybindingInput.command),
                ),
              }
            : {}),
        };
      });
      // A thread caller serializes with its own turn; a client has no thread to lock.
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
});
