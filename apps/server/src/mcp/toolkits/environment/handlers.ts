import {
  AuthSettingsWriteScope,
  ClientServerSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  isManagedSettingPath,
  OrchestratorMcpFailure,
  requiredScopesForServerSettingsPatch,
  ServerSettings,
  type ServerSettingsError,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import { advertisedSchemaOf } from "../../advertisedJsonSchema.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import {
  AGENT_SETTING_ACCESS,
  AGENT_WRITABLE_SETTING_KEYS,
  type AgentSettingKey,
  agentSettingAccess,
  LISTED_SETTING_KEYS,
} from "./settingsFields.ts";
import { EnvironmentToolkit } from "./tools.ts";

const AgentSettingsPatch = Schema.Struct(
  Struct.pick(ClientServerSettingsPatch.fields, AGENT_WRITABLE_SETTING_KEYS),
);
// The JSON codec, as `advertisedSchemaOf` describes it to the agent.
const decodeAgentPatch = Schema.decodeUnknownEffect(Schema.toCodecJson(AgentSettingsPatch));
const encodeSettings = Schema.encodeEffect(ServerSettings);
// Normalized as every loaded settings file is, so an untouched setting never reads as changed.
const defaults = withIdleCompaction(
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction(DEFAULT_SERVER_SETTINGS),
);
const encodedDefaults = Schema.encodeSync(ServerSettings)(defaults);

// Some keys are omitted from the encoded file when null.
const jsonValue = (
  settings: ServerSettings,
  encoded: Record<string, Schema.Json | undefined>,
  key: AgentSettingKey,
) => encoded[key] ?? (settings[key] === null ? null : undefined);
const GB = 1e9;
const gigabytes = (bytes: number) => Math.round((bytes / GB) * 10) / 10;

const machine = Effect.gen(function* () {
  const hostResources = yield* HostResources.HostResources;
  const [snapshot, pressure] = yield* Effect.all([hostResources.read, hostResources.readPressure], {
    concurrency: "unbounded",
  });
  return {
    pressure: {
      memory: pressure.memory,
      cpu: pressure.cpu,
      io: pressure.io,
      disk: pressure.disk,
    },
    cpuCount: snapshot.cpuCount,
    cpuUsedPercent:
      snapshot.cpuUtilization === null ? null : Math.round(snapshot.cpuUtilization * 100),
    memoryAvailableGb: gigabytes(snapshot.availableMemoryBytes),
    memoryTotalGb: gigabytes(snapshot.totalMemoryBytes),
    diskFreeGb:
      snapshot.diskFreeBytes === undefined || snapshot.diskFreeBytes === null
        ? null
        : gigabytes(snapshot.diskFreeBytes),
  };
});

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

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** What a client would be shown: secrets redacted, in the JSON shape `t3_settings_update` takes. */
const encodedForAgent = (settings: ServerSettings) =>
  encodeSettings(
    Settings.redactServerSettingsForClient(settings, { secretReferences: false }),
  ).pipe(Effect.mapError(unavailable)) as Effect.Effect<
    Record<string, Schema.Json | undefined>,
    OrchestratorMcpFailure
  >;

const entries = (
  service: Settings.ServerSettingsService["Service"],
  settings: ServerSettings,
  encoded: Record<string, Schema.Json | undefined>,
  keys: ReadonlyArray<AgentSettingKey>,
  withValues: boolean,
) =>
  keys.map((key) => {
    const value = jsonValue(settings, encoded, key);
    return {
      key,
      access: AGENT_SETTING_ACCESS[key] as "write" | "user" | "read",
      changed:
        JSON.stringify(value) !==
        JSON.stringify(jsonValue(defaults, encodedDefaults as Record<string, Schema.Json>, key)),
      ...(isManagedSettingPath(service.managedPolicy, key) ? { locked: true } : {}),
      // Only the user acts on `user` values, so agents never need to see them.
      ...(withValues && value !== undefined && AGENT_SETTING_ACCESS[key] !== "user"
        ? { value }
        : {}),
    };
  });

const unknownSetting = (key: string) =>
  invalid(`\`${key}\` is not a setting. Call \`t3_settings_read\` without \`keys\` for the list.`);

const requestedKeys = (keys: ReadonlyArray<string>) =>
  Effect.forEach(new Set(keys), (key) => {
    const level = agentSettingAccess(key);
    return level === undefined || level === "hidden"
      ? Effect.fail(unknownSetting(key))
      : Effect.succeed(key as AgentSettingKey);
  });

const refusedWrite = (key: string) => {
  const level = agentSettingAccess(key);
  if (level === undefined || level === "hidden") return unknownSetting(key);
  if (level === "user")
    return new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `Only the user can change \`${key}\`, in Settings. Ask them to.`,
    });
  if (key === "defaultTheme" || key === "defaultAppearance")
    return invalid(`Set \`${key}\` with \`t3_theme_set\`.`);
  return invalid(`\`${key}\` is maintained by T3 Code and cannot be set.`);
};

const settingsFailure = (error: ServerSettingsError) => {
  if (error.operation === "write-managed-setting" || error.operation === "use-disallowed-provider")
    return new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });
  if (error.operation === "read-file")
    return new OrchestratorMcpFailure({
      code: "orchestration_error",
      message:
        "This environment's settings.json could not be read, so no setting can change until the user fixes or removes it.",
    });
  return unavailable();
};

// Every connected client receives the whole settings object on each change.
const MAX_PATCH_CHARACTERS = 64_000;
const isOversized = (changes: Readonly<Record<string, Schema.Json>>) =>
  JSON.stringify(changes).length > MAX_PATCH_CHARACTERS;

/** These maps merge per entry; an entry the agent left out of the whole new map is removed. */
const withRemovedEntries = <Value>(
  next: Readonly<Record<string, Value | null>> | undefined,
  current: Readonly<Record<string, unknown>>,
) =>
  next === undefined
    ? undefined
    : {
        ...Object.fromEntries(
          Object.keys(current)
            .filter((entry) => !Object.hasOwn(next, entry))
            .map((entry) => [entry, null]),
        ),
        ...next,
      };

const asReplacement = (patch: typeof AgentSettingsPatch.Type, current: ServerSettings) => {
  const usagePriceOverrides = withRemovedEntries(
    patch.usagePriceOverrides,
    current.usagePriceOverrides,
  );
  const usageModelAliases = withRemovedEntries(patch.usageModelAliases, current.usageModelAliases);
  return {
    ...patch,
    ...(usagePriceOverrides === undefined ? {} : { usagePriceOverrides }),
    ...(usageModelAliases === undefined ? {} : { usageModelAliases }),
  };
};

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor } = yield* access;
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        machine: yield* machine,
      };
    }),
  ),
  t3_settings_read: McpToolAccess.reads(({ keys }) =>
    Effect.gen(function* () {
      const { settings } = yield* access;
      const requested = keys === undefined ? undefined : yield* requestedKeys(keys);
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const encoded = yield* encodedForAgent(current);
      if (requested === undefined)
        return { settings: entries(settings, current, encoded, LISTED_SETTING_KEYS, false) };
      const writable = AGENT_WRITABLE_SETTING_KEYS.filter((key) => requested.includes(key));
      return {
        settings: entries(settings, current, encoded, requested, true),
        ...(writable.length === 0
          ? {}
          : {
              schema: advertisedSchemaOf(
                Schema.Struct(Struct.pick(ClientServerSettingsPatch.fields, writable)),
              ) as Schema.Json,
            }),
      };
    }),
  ),
  t3_settings_update: McpToolAccess.writesEnvironment(({ settings: changes }, check) =>
    Effect.gen(function* () {
      const keys = Object.keys(changes);
      if (keys.length === 0) return yield* invalid("Give at least one setting in `settings`.");
      const refused = keys.find((key) => agentSettingAccess(key) !== "write");
      if (refused !== undefined) return yield* refusedWrite(refused);
      if (isOversized(changes))
        return yield* invalid(
          `\`settings\` is over ${MAX_PATCH_CHARACTERS} characters as JSON. Settings values are short; send less.`,
        );
      const patch = yield* decodeAgentPatch(changes).pipe(
        Effect.mapError((error) => invalid(Array.from(error.message).slice(0, 2000).join(""))),
      );
      // The RPC asks for more than settings:write when a value names a stored secret; agents never hold that.
      const scopes = requiredScopesForServerSettingsPatch(patch);
      if (scopes.some((scope) => scope !== AuthSettingsWriteScope))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only the user can point settings at stored secrets, in Settings.",
        });
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        const current = yield* settings.getSettings.pipe(Effect.mapError(settingsFailure));
        const next = yield* settings
          .updateSettings(asReplacement(patch, current))
          .pipe(Effect.mapError(settingsFailure));
        const encoded = yield* encodedForAgent(next);
        return { settings: entries(settings, next, encoded, keys as AgentSettingKey[], true) };
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
