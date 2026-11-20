import { msg } from "gt-react-native";
import {
  defaultInstanceIdForDriver,
  isManagedSettingPath,
  ProviderDriverKind,
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";

import { m } from "../../i18n/messages";

export const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
export const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);

export interface ClaudeAccountDraft {
  readonly name: string;
  readonly configDir: string;
}

function configRecord(instance: ProviderInstanceConfig | undefined): Record<string, unknown> {
  const config = instance?.config;
  return config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};
}

export function claudeConfigDir(instance: ProviderInstanceConfig | undefined): string {
  const homePath = configRecord(instance).homePath;
  return typeof homePath === "string" ? homePath : "";
}

export function planClaudeAccountSave(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly policy: ManagedPolicySummary | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly draft: ClaudeAccountDraft;
}): { readonly mutation: ProviderInstanceMutation } | { readonly error: string } {
  const name = input.draft.name.trim();
  const configDir = input.draft.configDir.trim();
  const instanceId = input.instanceId;
  if (input.policy && isManagedSettingPath(input.policy, `providerInstances.${instanceId}`)) {
    return {
      error: m(msg("Managed by {organization}.", { organization: input.policy.organization })),
    };
  }
  const current: ProviderInstanceConfig = Object.hasOwn(input.providerInstances, instanceId)
    ? input.providerInstances[instanceId]!
    : { driver: CLAUDE_DRIVER };
  const { displayName: _displayName, config: _config, ...rest } = current;
  const { homePath: _homePath, ...config } = configRecord(current);
  const nextConfig = configDir ? { ...config, homePath: configDir } : config;
  const instance: ProviderInstanceConfig = {
    ...rest,
    ...(name ? { displayName: name } : {}),
    ...(Object.keys(nextConfig).length > 0 ? { config: nextConfig } : {}),
  };
  return {
    mutation: { operation: "upsert", instanceId, instance },
  };
}
