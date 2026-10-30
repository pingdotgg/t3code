import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  disallowedProviderMessage,
  type ManagedProviderInstance,
  type ManagedProviderLimits,
  type ManagedPolicySummary,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";

interface KnownDriver {
  readonly label: string;
  readonly configFields: ReadonlySet<string>;
  readonly hasDefaultInstance: boolean;
}

const known = (
  driverKind: string,
  label: string,
  settingsSchema: { readonly fields: object },
  hasDefaultInstance = true,
) =>
  [
    ProviderDriverKind.make(driverKind),
    { label, configFields: new Set(Object.keys(settingsSchema.fields)), hasDefaultInstance },
  ] as const;

const PACKAGED_CLIENTS: ReadonlyArray<ProviderClientDefinition> = [
  cursorClient,
  grokClient,
  fxClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
];

/**
 * Fields that make an instance launch without the settings a pin sets: managed Codex runs T3's own
 * runtime against OpenAI. A policy that owns a pin owns these too, leaving them at their defaults.
 */
const PIN_BYPASS_FIELDS: ReadonlyMap<ProviderDriverKind, ReadonlyArray<string>> = new Map([
  [ProviderDriverKind.make("codex"), ["setupMode"]],
]);

/** Drivers this build knows, by the names users see; a policy naming any other is refused. */
const KNOWN_DRIVERS: ReadonlyMap<ProviderDriverKind, KnownDriver> = new Map([
  known("codex", "Codex", CodexSettings),
  known("claudeAgent", "Claude", ClaudeSettings),
  known("antigravity", "Antigravity", AntigravitySettings),
  ...PACKAGED_CLIENTS.map((client) =>
    known(client.driverKind, client.label, client.settingsSchema, client.hasDefaultInstance),
  ),
]);

/** Each driver a policy may name, with the label users see. */
export const knownDriverLabels = () =>
  Array.from(KNOWN_DRIVERS, ([driver, { label }]) => ({ driver, label }));

const PINNED_CONFIG_FIELDS = ["binaryPath", "launchArgs"] as const;
type PinnedConfigField = (typeof PINNED_CONFIG_FIELDS)[number];

/**
 * Fields that decide what a provider starts and reads on startup; a driver has those its schema
 * has. Under a ceiling they are the administrator's: a wrapper binary, a skip-permissions flag, or
 * a config directory with allow rules each outrank T3 Code's mode, and no flag filter stops a wrapper.
 */
const LAUNCH_CONFIG_FIELDS = [
  "binaryPath",
  "launchArgs",
  "homePath",
  "shadowHomePath",
  "commandPath",
  "commandArgs",
  "serverUrl",
] as const;

export type ProviderWriteVerdict =
  | { readonly _tag: "Allowed"; readonly settings: ServerSettings }
  | { readonly _tag: "Locked"; readonly path: string }
  | {
      readonly _tag: "Disallowed";
      readonly instanceId: ProviderInstanceId;
      readonly label: string;
    };

/**
 * How a policy's `limits.providers` shapes provider instances. Like settings locks, pinned
 * fields are laid over instances on every read and never written to the user's settings file.
 */
export interface ManagedProviders {
  readonly isDriverAllowed: (driver: ProviderDriverKind) => boolean;
  /** Lay pinned fields over every instance of a pinned driver, its default instance included. */
  readonly applyLimits: (settings: ServerSettings) => ServerSettings;
  /**
   * Vet a write from stored `current` to `next`. Refuses enabling a disallowed driver and moving
   * a locked field off its pinned value. Pinned values a client sends back are dropped, so the
   * user's own values return once the policy is gone.
   */
  readonly vetWrite: (current: ServerSettings, next: ServerSettings) => ProviderWriteVerdict;
  /**
   * Per driver, the instance fields users cannot change, for clients. `environment` alone means
   * every variable.
   */
  readonly lockedInstanceFields: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const unmanagedProviders: ManagedProviders = {
  isDriverAllowed: () => true,
  applyLimits: (settings) => settings,
  vetWrite: (_current, next) => ({ _tag: "Allowed", settings: next }),
  lockedInstanceFields: {},
};

const labelFor = (driver: ProviderDriverKind) => KNOWN_DRIVERS.get(driver)?.label ?? driver;

/** Why the policy clients were told about keeps `driver` from running, or undefined when it may run. */
export const disallowedDriverReason = (
  summary: ManagedPolicySummary | undefined,
  driver: ProviderDriverKind,
): string | undefined => {
  const allowed = summary?.limits?.providers?.allowedDrivers;
  return allowed === undefined || allowed.includes(driver)
    ? undefined
    : disallowedProviderMessage(summary?.organization, labelFor(driver));
};

/**
 * Host variables that replace a provider's launch configuration. They come from whoever starts
 * the server, so a runtime-mode ceiling, which makes launch configuration the administrator's,
 * ignores them.
 */
const LAUNCH_OVERRIDE_VARIABLES = ["T3CODE_CODEX_LAUNCH_ARGS"] as const;

/** The environment provider drivers launch from under the policy clients were told about. */
export const providerHostEnvironment = (
  summary: ManagedPolicySummary | undefined,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  if (summary?.limits?.maxRuntimeMode === undefined) return environment;
  const next = { ...environment };
  for (const name of LAUNCH_OVERRIDE_VARIABLES) delete next[name];
  return next;
};

const configRecord = (instance: ProviderInstanceConfig | undefined): Record<string, unknown> =>
  instance?.config !== null &&
  typeof instance?.config === "object" &&
  !Array.isArray(instance.config)
    ? (instance.config as Record<string, unknown>)
    : {};

/** Empty strings and empty lists are how clients clear a field, so they count as unset. */
const configValue = (instance: ProviderInstanceConfig | undefined, field: string) => {
  const value = configRecord(instance)[field];
  return value === "" || (Array.isArray(value) && value.length === 0) ? undefined : value;
};

const sameValue = (left: unknown, right: unknown) =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

const sameVariable = (
  left: ProviderInstanceEnvironmentVariable | undefined,
  right: ProviderInstanceEnvironmentVariable | undefined,
) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.value === right.value &&
    left.sensitive === right.sensitive);

const pinnedFields = (pin: ManagedProviderInstance): ReadonlyArray<PinnedConfigField> =>
  PINNED_CONFIG_FIELDS.filter((field) => pin[field] !== undefined);

/**
 * What the administrator owns on one driver's instances. `config` fields take the pin or the
 * default, never the user's value; `fill` fields take the pin only where the user left them empty.
 * `environment`: `all` runs with only pinned variables, `locked` lets them win, `fill` fills gaps.
 */
interface DriverRule {
  readonly pin: ManagedProviderInstance | undefined;
  readonly config: ReadonlyArray<string>;
  readonly fill: ReadonlyArray<PinnedConfigField>;
  readonly environment: "all" | "locked" | "fill";
}

const pinnedValue = (pin: ManagedProviderInstance | undefined, field: string): unknown =>
  pin === undefined ? undefined : (pin as Record<string, unknown>)[field];

const overlayInstance = (
  instance: ProviderInstanceConfig,
  rule: DriverRule,
): ProviderInstanceConfig => {
  const config = { ...configRecord(instance) };
  for (const field of rule.config) {
    const value = pinnedValue(rule.pin, field);
    if (value === undefined) delete config[field];
    else config[field] = value;
  }
  for (const field of rule.fill) {
    if (configValue(instance, field) === undefined) config[field] = rule.pin?.[field];
  }
  const pinnedEnvironment = (rule.pin?.environment ?? []).map((variable) => ({
    name: variable.name,
    value: variable.value,
    sensitive: false,
  }));
  const pinnedByName = new Map(pinnedEnvironment.map((variable) => [variable.name, variable]));
  const environment: Array<NonNullable<ProviderInstanceConfig["environment"]>[number]> =
    rule.environment === "all" ? pinnedEnvironment : [];
  if (rule.environment !== "all") {
    const seen = new Set<string>();
    // The last entry for a name wins at launch, so a lock replaces every entry with that name.
    for (const variable of instance.environment ?? []) {
      const pinned = rule.environment === "locked" ? pinnedByName.get(variable.name) : undefined;
      if (pinned === undefined) environment.push(variable);
      else if (!seen.has(variable.name)) environment.push(pinned);
      seen.add(variable.name);
    }
    for (const pinned of pinnedEnvironment) {
      if (!seen.has(pinned.name)) environment.push(pinned);
    }
  }
  const { config: _config, environment: _environment, ...envelope } = instance;
  return {
    ...envelope,
    ...(instance.config === undefined && Object.keys(config).length === 0 ? {} : { config }),
    ...(environment.length === 0 ? {} : { environment }),
  };
};

/**
 * Build the overlay for `limits.providers` and `limits.maxRuntimeMode`, or say why it cannot be
 * enforced. A ceiling takes each driver's launch fields and its whole `environment`, which can
 * carry `CLAUDE_CONFIG_DIR`, `PATH`, or `NODE_OPTIONS`; a deny list would miss the next one.
 */
export function makeManagedProviders(
  limits: ManagedProviderLimits,
  maxRuntimeMode?: RuntimeMode,
):
  | { readonly _tag: "Valid"; readonly providers: ManagedProviders }
  | { readonly _tag: "Invalid"; readonly reason: string } {
  for (const driver of limits.allowedDrivers ?? []) {
    if (!KNOWN_DRIVERS.has(driver)) {
      return { _tag: "Invalid", reason: `"${driver}" in allowedDrivers is not a known provider` };
    }
  }
  const pins = new Map<ProviderDriverKind, ManagedProviderInstance>();
  for (const [rawDriver, pin] of Object.entries(limits.instances ?? {})) {
    const driver = ProviderDriverKind.make(rawDriver);
    const known = KNOWN_DRIVERS.get(driver);
    if (known === undefined) {
      return { _tag: "Invalid", reason: `"${driver}" in instances is not a known provider` };
    }
    const unsupported = pinnedFields(pin).find((field) => !known.configFields.has(field));
    if (unsupported !== undefined) {
      return {
        _tag: "Invalid",
        reason: `the ${known.label} provider has no ${unsupported} setting`,
      };
    }
    const names = (pin.environment ?? []).map((variable) => variable.name);
    if (new Set(names).size !== names.length) {
      return { _tag: "Invalid", reason: `instances.${driver}.environment repeats a variable` };
    }
    pins.set(driver, pin);
  }

  const rules = new Map<ProviderDriverKind, DriverRule>();
  for (const [driver, known] of KNOWN_DRIVERS) {
    const pin = pins.get(driver);
    const bypasses = pin === undefined ? [] : (PIN_BYPASS_FIELDS.get(driver) ?? []);
    if (maxRuntimeMode !== undefined) {
      rules.set(driver, {
        pin,
        config: [
          ...LAUNCH_CONFIG_FIELDS.filter((field) => known.configFields.has(field)),
          ...bypasses,
        ],
        fill: [],
        environment: "all",
      });
    } else if (pin !== undefined) {
      rules.set(driver, {
        pin,
        config: pin.locked ? [...pinnedFields(pin), ...bypasses] : [],
        fill: pin.locked ? [] : pinnedFields(pin),
        environment: pin.locked ? "locked" : "fill",
      });
    }
  }

  const allowed =
    limits.allowedDrivers === undefined ? undefined : new Set<string>(limits.allowedDrivers);
  const isDriverAllowed = (driver: ProviderDriverKind) => allowed?.has(driver) ?? true;
  const allowedSelection = (
    settings: ServerSettings,
    selection: { readonly instanceId: ProviderInstanceId } | null | undefined,
  ) =>
    selection == null ||
    isDriverAllowed(
      settings.providerInstances[selection.instanceId]?.driver ??
        ProviderDriverKind.make(selection.instanceId),
    );

  const cache = new WeakMap<ServerSettings, ServerSettings>();
  const applyLimits = (settings: ServerSettings): ServerSettings => {
    const cached = cache.get(settings);
    if (cached !== undefined) return cached;
    const providerInstances: Record<string, ProviderInstanceConfig> = {
      ...settings.providerInstances,
    };
    // Default instances exist without a settings entry until the user edits one; pin them too.
    for (const driver of pins.keys()) {
      const instanceId = defaultInstanceIdForDriver(driver);
      if (KNOWN_DRIVERS.get(driver)?.hasDefaultInstance === false) continue;
      if (providerInstances[instanceId] === undefined) providerInstances[instanceId] = { driver };
    }
    for (const [instanceId, instance] of Object.entries(providerInstances)) {
      const rule = rules.get(instance.driver);
      if (rule !== undefined) providerInstances[instanceId] = overlayInstance(instance, rule);
    }
    // A cleared selection falls back to the text generation model, which is resolved afterwards.
    const result: ServerSettings = {
      ...settings,
      providerInstances: providerInstances as ServerSettings["providerInstances"],
      sourceControlWriterModelSelection: allowedSelection(
        settings,
        settings.sourceControlWriterModelSelection,
      )
        ? settings.sourceControlWriterModelSelection
        : null,
      reviewGuideModelSelection: allowedSelection(settings, settings.reviewGuideModelSelection)
        ? settings.reviewGuideModelSelection
        : null,
    };
    cache.set(settings, result);
    return result;
  };

  type Locked = { readonly _tag: "Locked"; readonly path: string };

  /**
   * Vet the environment a client sent. Pinned values it echoes back are dropped; anything else
   * the administrator owns must match what is stored. Returns the environment to store.
   */
  const vetEnvironment = (
    instanceId: string,
    stored: ProviderInstanceConfig | undefined,
    next: ProviderInstanceConfig,
    rule: DriverRule,
  ):
    | Locked
    | {
        readonly _tag: "Kept";
        readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
      } => {
    const pinned = rule.pin?.environment ?? [];
    const storedVariable = (name: string) =>
      stored?.environment?.find((existing) => existing.name === name);
    const storedUnchanged = (variable: ProviderInstanceEnvironmentVariable) =>
      (stored?.environment ?? []).some((existing) => sameVariable(variable, existing));
    const echoed = (variable: ProviderInstanceEnvironmentVariable) =>
      !variable.sensitive &&
      pinned.some((pin) => pin.name === variable.name && pin.value === variable.value);
    if (rule.environment === "all") {
      // Only the pinned variables were shown, so the user's own stay as stored.
      for (const variable of next.environment ?? []) {
        if (echoed(variable) || storedUnchanged(variable)) continue;
        return { _tag: "Locked", path: `providerInstances.${instanceId}.environment` };
      }
      return { _tag: "Kept", environment: stored?.environment ?? [] };
    }
    let environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = next.environment ?? [];
    for (const variable of pinned) {
      const sent = environment.find((existing) => existing.name === variable.name);
      const kept = storedVariable(variable.name);
      if ((sent !== undefined && echoed(sent)) || sameVariable(sent, kept)) {
        // Put the user's own entries back where it was sent, or drop the echoed policy value.
        const storedEntries = (stored?.environment ?? []).filter(
          (existing) => existing.name === variable.name,
        );
        let restored = false;
        environment = environment.flatMap((existing) => {
          if (existing.name !== variable.name) return [existing];
          if (restored) return [];
          restored = true;
          return storedEntries;
        });
      } else if (rule.environment === "locked") {
        return {
          _tag: "Locked",
          path: `providerInstances.${instanceId}.environment.${variable.name}`,
        };
      }
    }
    return { _tag: "Kept", environment };
  };

  const vetInstance = (
    instanceId: string,
    stored: ProviderInstanceConfig | undefined,
    next: ProviderInstanceConfig,
    rule: DriverRule,
  ): Locked | { readonly _tag: "Kept"; readonly instance: ProviderInstanceConfig | undefined } => {
    const config = { ...configRecord(next) };
    for (const field of [...rule.config, ...rule.fill]) {
      const value = configValue(next, field);
      const storedValue = configValue(stored, field);
      if (sameValue(value, pinnedValue(rule.pin, field)) || sameValue(value, storedValue)) {
        if (storedValue === undefined) delete config[field];
        else config[field] = configRecord(stored)[field];
      } else if (rule.config.includes(field)) {
        return { _tag: "Locked", path: `providerInstances.${instanceId}.config.${field}` };
      }
    }
    const vettedEnvironment = vetEnvironment(instanceId, stored, next, rule);
    if (vettedEnvironment._tag === "Locked") return vettedEnvironment;
    const { environment } = vettedEnvironment;
    const { config: _config, environment: _environment, ...envelope } = next;
    const kept: ProviderInstanceConfig = {
      ...envelope,
      ...(Object.keys(config).length === 0 && stored?.config === undefined ? {} : { config }),
      ...(environment.length === 0 ? {} : { environment }),
    };
    // A default instance the client echoed back with only pinned values stays implicit.
    const echoedDefault =
      stored === undefined &&
      instanceId === defaultInstanceIdForDriver(next.driver) &&
      Object.keys(kept).length === 1;
    return { _tag: "Kept", instance: echoedDefault ? undefined : kept };
  };

  const vetWrite = (current: ServerSettings, next: ServerSettings): ProviderWriteVerdict => {
    const providerInstances: Record<string, ProviderInstanceConfig> = {};
    for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
      const stored = current.providerInstances[instanceId as ProviderInstanceId];
      // Clients echo instances with policy fields laid over them, so compare only whether it runs.
      // A driver's default instance runs before it is configured.
      const wasEnabled =
        stored !== undefined
          ? stored.driver === instance.driver && resolveProviderInstanceEnabled(stored)
          : instanceId === defaultInstanceIdForDriver(instance.driver);
      if (
        !isDriverAllowed(instance.driver) &&
        resolveProviderInstanceEnabled(instance) &&
        !wasEnabled
      ) {
        return {
          _tag: "Disallowed",
          instanceId: instanceId as ProviderInstanceId,
          label: labelFor(instance.driver),
        };
      }
      const rule = rules.get(instance.driver);
      if (rule === undefined) {
        providerInstances[instanceId] = instance;
        continue;
      }
      const vetted = vetInstance(
        instanceId,
        stored?.driver === instance.driver ? stored : undefined,
        instance,
        rule,
      );
      if (vetted._tag === "Locked") return vetted;
      if (vetted.instance !== undefined) providerInstances[instanceId] = vetted.instance;
    }
    // A project can switch an instance on for itself; that is enabling it too.
    for (const [projectId, overrides] of Object.entries(next.projectSettingsOverrides)) {
      const storedOverrides =
        current.projectSettingsOverrides[projectId as keyof typeof current.projectSettingsOverrides]
          ?.providerInstances;
      for (const [instanceId, override] of Object.entries(overrides.providerInstances ?? {})) {
        const driver =
          next.providerInstances[instanceId as ProviderInstanceId]?.driver ??
          ProviderDriverKind.make(instanceId);
        if (
          override.enabled === true &&
          storedOverrides?.[instanceId as ProviderInstanceId]?.enabled !== true &&
          !isDriverAllowed(driver)
        ) {
          return {
            _tag: "Disallowed",
            instanceId: instanceId as ProviderInstanceId,
            label: labelFor(driver),
          };
        }
      }
    }
    return {
      _tag: "Allowed",
      settings: {
        ...next,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      },
    };
  };

  const lockedInstanceFields = Object.fromEntries(
    [...rules].flatMap(([driver, rule]) => {
      const fields = [
        ...rule.config.map((field) => `config.${field}`),
        ...(rule.environment === "all"
          ? ["environment"]
          : rule.environment === "locked"
            ? (rule.pin?.environment ?? []).map((variable) => `environment.${variable.name}`)
            : []),
      ];
      return fields.length === 0 ? [] : [[driver, fields] as const];
    }),
  );

  return {
    _tag: "Valid",
    providers: {
      isDriverAllowed,
      applyLimits,
      vetWrite,
      lockedInstanceFields,
    },
  };
}
