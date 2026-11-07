import {
  EasDeviceHostConfig,
  isSecretReference,
  secretReferencesInSettings,
  type ServerSettings,
  UsageLimitSourceConfig,
} from "@t3tools/contracts";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { deriveProviderSettingsFields, type SettingsFormDefinition } from "./ProviderSettingsForm";

type SecretUseSettings = Pick<
  ServerSettings,
  "providerInstances" | "sourceControlHosts" | "usageLimitSources" | "easDeviceHosts"
>;

interface SecretProviderUse {
  readonly id: string;
  readonly label: string;
}

/** What reads from secret provider `providerId`, one readable name per field, in settings order. */
export function secretProviderUses(
  settings: SecretUseSettings,
  providerId: string,
): ReadonlyArray<SecretProviderUse> {
  const uses = (
    definition: SettingsFormDefinition,
    ownerId: string,
    owner: string,
    value: unknown,
  ): ReadonlyArray<SecretProviderUse> => {
    const labels = new Map(
      deriveProviderSettingsFields(definition).map((field) => [field.key, field.label] as const),
    );
    return secretReferencesInSettings(definition.settingsSchema, value).flatMap(
      ({ field, key, reference }) =>
        reference.provider === providerId
          ? [
              {
                id: `${ownerId}:${field}:${key ?? ""}`,
                label: `${owner} · ${key ?? labels.get(field) ?? field}`,
              },
            ]
          : [],
    );
  };

  return [
    ...Object.entries(settings.providerInstances).flatMap(([instanceId, instance]) => {
      const client = getProviderClient(instance.driver);
      const owner = instance.displayName ?? client?.label ?? instanceId;
      return [
        ...(client ? uses(client, `provider:${instanceId}`, owner, instance.config) : []),
        ...(instance.environment ?? []).flatMap((variable) =>
          isSecretReference(variable.value) && variable.value.provider === providerId
            ? [
                {
                  id: `provider:${instanceId}:env:${variable.name}`,
                  label: `${owner} · ${variable.name}`,
                },
              ]
            : [],
        ),
      ];
    }),
    ...sourceControlClients.definitions.flatMap((definition) =>
      definition.settings
        ? uses(
            { settingsSchema: definition.settings },
            `source-control:${definition.kind}`,
            definition.label,
            settings.sourceControlHosts[definition.kind],
          )
        : [],
    ),
    ...Object.entries(settings.usageLimitSources).flatMap(([id, source]) =>
      uses(
        { settingsSchema: UsageLimitSourceConfig },
        `usage-limit:${id}`,
        source.label ?? source.url,
        source,
      ),
    ),
    ...settings.easDeviceHosts.flatMap((host) =>
      uses({ settingsSchema: EasDeviceHostConfig }, `eas:${host.id}`, host.label, host),
    ),
  ];
}
