import {
  AntigravitySettings,
  ClaudeSettings,
  CloudSpeechCredentials,
  CodexSettings,
  EasDeviceHostConfig,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
  type SettingsSecretValue,
  SimlockDeviceHostConfig,
  TextGeneratorConfig,
  UsageLimitSourceConfig,
  type UsageLimitSourceId,
  isSecretReference,
  secretSettingsFields,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import { vibeClient } from "@t3tools/provider-vibe/client";
import {
  readSecretFieldValues,
  SOURCE_CONTROL_HOST_SECRET_FIELDS,
  sourceControlHostSecretName,
  writeSecretFieldValues,
} from "./sourceControl/sourceControlHostSecrets.ts";

export const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

const providerSecretFields = new Map([
  ["codex", secretSettingsFields(CodexSettings)],
  ["claudeAgent", secretSettingsFields(ClaudeSettings)],
  ["antigravity", secretSettingsFields(AntigravitySettings)],
  ...[
    cursorClient,
    grokClient,
    kiroClient,
    museClient,
    openCodeClient,
    piClient,
    vibeClient,
    acpRegistryClient,
  ].map(
    (definition) =>
      [definition.driverKind, secretSettingsFields(definition.settingsSchema)] as const,
  ),
]);
const usageLimitSecretFields = secretSettingsFields(UsageLimitSourceConfig);
const textGeneratorSecretFields = secretSettingsFields(TextGeneratorConfig);
const voiceSecretFields = secretSettingsFields(CloudSpeechCredentials);
const easDeviceHostSecretFields = secretSettingsFields(EasDeviceHostConfig);
const simlockDeviceHostSecretFields = secretSettingsFields(SimlockDeviceHostConfig);
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export interface SettingsSecret {
  readonly secretName: string;
  readonly kind: "field" | "environment";
  readonly value: string;
  readonly redacted: boolean;
  readonly sensitive: boolean;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
}

type SecretValue = Pick<SettingsSecret, "value" | "redacted">;
type SecretSlotName = (field: string, serverHost: string | null) => string;
type SecretFieldsMapper = (
  fields: Readonly<Record<string, unknown>>,
  secretFields: ReadonlyArray<string>,
  name: SecretSlotName,
) => Record<string, unknown>;
type ProviderEnvironment = NonNullable<ProviderInstanceConfig["environment"]>;

export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields: SecretFieldsMapper = (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next) || isSecretReference(next[field])) continue;
      next[field] = writeSecretFieldValues(
        next[field],
        readSecretFieldValues(next[field]).map(([serverHost, value]) => {
          const result = map({
            secretName: name(field, serverHost),
            kind: "field",
            value,
            redacted: value === SECRET_REDACTED,
            sensitive: true,
          });
          return [serverHost, result.redacted ? SECRET_REDACTED : result.value] as const;
        }),
      );
    }
    return next;
  };

  return mapSecretFieldGroups(settings, mapFields, (instanceId, environment) =>
    environment.map((variable) => {
      const { valueRedacted: _omit, ...rest } = variable;
      // A secret reference is not itself secret; storage sees the value cleared.
      const reference = typeof variable.value === "string" ? undefined : variable.value;
      const result = map({
        secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
        kind: "environment",
        value: typeof variable.value === "string" ? variable.value : "",
        redacted: reference === undefined && variable.valueRedacted === true,
        sensitive: variable.sensitive,
        providerInstanceId: instanceId,
        environmentVariable: variable.name,
      });
      if (reference !== undefined) return { ...rest, value: reference };
      return {
        ...rest,
        value: result.value,
        ...(result.redacted ? { valueRedacted: true } : {}),
      };
    }),
  );
}

/**
 * Maps each value a secret field holds, literal or reference, with the secret name of its slot.
 * Provider environment variables are left as they are.
 */
export function mapSettingsSecretValues(
  settings: ServerSettings,
  map: (value: SettingsSecretValue, secretName: string) => SettingsSecretValue,
): ServerSettings {
  const mapValue = (value: unknown, secretName: string) =>
    typeof value === "string" || isSecretReference(value) ? map(value, secretName) : value;
  return mapSecretFieldGroups(settings, (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next)) continue;
      const value = next[field];
      next[field] =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !isSecretReference(value)
          ? Object.fromEntries(
              Object.entries(value).map(([serverHost, entry]) => [
                serverHost,
                mapValue(entry, name(field, serverHost.trim().toLowerCase())),
              ]),
            )
          : mapValue(value, name(field, null));
    }
    return next;
  });
}

function mapSecretFieldGroups(
  settings: ServerSettings,
  mapFields: SecretFieldsMapper,
  mapEnvironment: (instanceId: string, environment: ProviderEnvironment) => ProviderEnvironment = (
    _instanceId,
    environment,
  ) => environment,
): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config = instance.config;
      return [
        instanceId,
        {
          ...instance,
          ...(config !== null && typeof config === "object" && !Array.isArray(config)
            ? {
                config: mapFields(
                  config as Record<string, unknown>,
                  providerSecretFields.get(instance.driver) ?? [],
                  (field, serverHost) =>
                    `provider-config-${encode(instanceId)}-${encode(instance.driver)}-${encode(field)}` +
                    (serverHost === null ? "" : `-${encode(serverHost)}`),
                ),
              }
            : {}),
          ...(instance.environment
            ? { environment: mapEnvironment(instanceId, instance.environment) }
            : {}),
        },
      ];
    }),
  );

  const sourceControlHosts = Object.fromEntries(
    Object.entries(settings.sourceControlHosts).map(([kind, fields]) => [
      kind,
      mapFields(fields, SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? [], (field, serverHost) =>
        sourceControlHostSecretName({ kind, field, serverHost }),
      ),
    ]),
  ) as ServerSettings["sourceControlHosts"];

  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      mapFields(
        source,
        usageLimitSecretFields,
        (field, serverHost) =>
          `usage-limit-source-${encode(id)}` +
          (field === "managementKey" && serverHost === null
            ? ""
            : `-${encode(field)}${serverHost === null ? "" : `-${encode(serverHost)}`}`),
      ),
    ]),
  ) as ServerSettings["usageLimitSources"];

  const textGenerators = Object.fromEntries(
    Object.entries(settings.textGenerators).map(([id, generator]) => [
      id,
      mapFields(
        generator,
        textGeneratorSecretFields,
        (field, serverHost) =>
          `text-generator-${encode(id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ),
    ]),
  ) as ServerSettings["textGenerators"];

  const easDeviceHosts = settings.easDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        easDeviceHostSecretFields,
        (field, serverHost) =>
          `device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as EasDeviceHostConfig,
  );

  // Its own prefix: an Expo and a Simlock host may share an id.
  const simlockDeviceHosts = settings.simlockDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        simlockDeviceHostSecretFields,
        (field, serverHost) =>
          `simlock-device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as SimlockDeviceHostConfig,
  );

  return {
    ...settings,
    cloudSpeechCredentials: mapFields(
      settings.cloudSpeechCredentials,
      voiceSecretFields,
      (provider) => `voice-cloud-${provider}`,
    ) as ServerSettings["cloudSpeechCredentials"],
    providerInstances,
    sourceControlHosts,
    usageLimitSources,
    textGenerators,
    easDeviceHosts,
    simlockDeviceHosts,
  };
}

/**
 * `next` with every secret reference to a secret provider that `current` has and `next` dropped
 * unset: a credential field becomes empty, and a provider variable holding one is removed.
 */
export function withoutRemovedSecretProviderReferences(
  current: ServerSettings,
  next: ServerSettings,
): ServerSettings {
  const removed = new Set(
    Object.keys(current.secretProviders).filter((id) => !Object.hasOwn(next.secretProviders, id)),
  );
  if (removed.size === 0) return next;
  const isRemoved = (value: unknown) => isSecretReference(value) && removed.has(value.provider);
  const fields = mapSettingsSecretValues(next, (value) => (isRemoved(value) ? "" : value));
  return {
    ...fields,
    providerInstances: Object.fromEntries(
      Object.entries(fields.providerInstances).map(([instanceId, instance]) => [
        instanceId,
        instance.environment?.some((variable) => isRemoved(variable.value))
          ? {
              ...instance,
              environment: instance.environment.filter((variable) => !isRemoved(variable.value)),
            }
          : instance,
      ]),
    ),
  };
}

/** A URL in the form two spellings of one address share: `URL` normalization, no trailing slash on the path. */
const destination = (url: unknown) => {
  if (typeof url !== "string" || !URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
};

/** Per provider driver, the config field holding a secret and the one naming where it is sent. */
const providerSecretDestinations = new Map<string, readonly [secret: string, url: string]>([
  [openCodeClient.driverKind, ["serverPassword", "serverUrl"]],
]);

/**
 * `next` with a kept secret cleared when the address it is sent to changed: a saved secret goes
 * only to the address it was saved for. A newly entered secret stays.
 */
export function withoutRedirectedSecrets(
  current: ServerSettings,
  next: ServerSettings,
): ServerSettings {
  const kept = (secret: unknown, saved: unknown) =>
    secret === SECRET_REDACTED ||
    (isSecretReference(secret) &&
      isSecretReference(saved) &&
      secret.provider === saved.provider &&
      secret.reference === saved.reference);
  const rebound = <T extends object>(
    entry: T,
    previous: object | null | undefined,
    secret: string,
    url: string,
  ): T => {
    if (previous === null || previous === undefined) return entry;
    const fields = entry as Readonly<Record<string, unknown>>;
    const saved = previous as Readonly<Record<string, unknown>>;
    return destination(saved[url]) !== destination(fields[url]) &&
      kept(fields[secret], saved[secret])
      ? { ...entry, [secret]: "" }
      : entry;
  };
  const simlockHosts = new Map(current.simlockDeviceHosts.map((host) => [host.id, host]));
  return {
    ...next,
    providerInstances: Object.fromEntries(
      Object.entries(next.providerInstances).map(([instanceId, instance]) => {
        const fields = providerSecretDestinations.get(instance.driver);
        const previous = current.providerInstances[instanceId as ProviderInstanceId];
        return [
          instanceId,
          fields !== undefined &&
          previous?.driver === instance.driver &&
          Predicate.isObject(instance.config) &&
          Predicate.isObject(previous.config)
            ? { ...instance, config: rebound(instance.config, previous.config, ...fields) }
            : instance,
        ];
      }),
    ) as ServerSettings["providerInstances"],
    usageLimitSources: Object.fromEntries(
      Object.entries(next.usageLimitSources).map(([id, source]) => [
        id,
        rebound(
          source,
          current.usageLimitSources[id as UsageLimitSourceId],
          "managementKey",
          "url",
        ),
      ]),
    ) as ServerSettings["usageLimitSources"],
    textGenerators: Object.fromEntries(
      Object.entries(next.textGenerators).map(([id, generator]) => [
        id,
        rebound(generator, current.textGenerators[id as ProviderInstanceId], "apiKey", "baseUrl"),
      ]),
    ) as ServerSettings["textGenerators"],
    simlockDeviceHosts: next.simlockDeviceHosts.map((host) =>
      rebound(host, simlockHosts.get(host.id), "agentToken", "gatewayUrl"),
    ),
  };
}
