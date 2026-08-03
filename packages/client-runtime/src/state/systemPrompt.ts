/**
 * Client-side helpers for the system prompt injection settings (fork f2).
 *
 * Pure: there is no RPC surface. The rules ride `ServerSettings`, which the
 * client already receives through `serverGetSettings` / `subscribeServerConfig`
 * and writes through `serverUpdateSettings`.
 *
 * Rule ids are derived from scope rather than generated, so an edit made on one
 * client lines up with the same rule on another instead of appending a
 * duplicate.
 *
 * @module state/systemPrompt
 */
import {
  resolveSystemPromptInjection,
  systemPromptInjectionSupport,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type SystemPromptInjectionSettings,
  type SystemPromptInjectionSupport,
  type SystemPromptRule,
} from "@t3tools/contracts";

export const GLOBAL_SYSTEM_PROMPT_RULE_ID = "global";

export const EMPTY_SYSTEM_PROMPT_INJECTION: SystemPromptInjectionSettings = {
  schemaVersion: 1,
  enabled: true,
  rules: [],
};

/** Stable id for the rule covering one scope. */
export function systemPromptRuleId(instanceId?: ProviderInstanceId): string {
  return instanceId === undefined ? GLOBAL_SYSTEM_PROMPT_RULE_ID : `instance:${instanceId}`;
}

export function readSystemPromptRule(
  settings: SystemPromptInjectionSettings,
  instanceId?: ProviderInstanceId,
): SystemPromptRule | undefined {
  const id = systemPromptRuleId(instanceId);
  return settings.rules.find((rule) => rule.id === id);
}

/** Instances that do not have an override rule yet, in the given order. */
export function systemPromptOverrideCandidates(
  settings: SystemPromptInjectionSettings,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.enabled && readSystemPromptRule(settings, provider.instanceId) === undefined,
  );
}

/**
 * Insert or replace one rule, keeping the global rule first and preserving the
 * order of every other rule. Composition order follows array order, so a
 * per-instance override reads after the global text.
 */
export function upsertSystemPromptRule(
  settings: SystemPromptInjectionSettings,
  rule: SystemPromptRule,
): SystemPromptInjectionSettings {
  const existingIndex = settings.rules.findIndex((candidate) => candidate.id === rule.id);
  if (existingIndex >= 0) {
    const rules = [...settings.rules];
    rules[existingIndex] = rule;
    return { ...settings, rules };
  }
  const rules =
    rule.id === GLOBAL_SYSTEM_PROMPT_RULE_ID
      ? [rule, ...settings.rules]
      : [...settings.rules, rule];
  return { ...settings, rules };
}

export function removeSystemPromptRule(
  settings: SystemPromptInjectionSettings,
  ruleId: string,
): SystemPromptInjectionSettings {
  return { ...settings, rules: settings.rules.filter((rule) => rule.id !== ruleId) };
}

export function setSystemPromptRuleEnabled(
  settings: SystemPromptInjectionSettings,
  ruleId: string,
  enabled: boolean,
): SystemPromptInjectionSettings {
  return {
    ...settings,
    rules: settings.rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule)),
  };
}

export interface SystemPromptPreviewEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly support: SystemPromptInjectionSupport;
  /** Exactly what the adapter would receive, or undefined for nothing. */
  readonly text: string | undefined;
}

/**
 * One preview row per enabled provider instance, rendering the exact text the
 * server would attach. Both sides call `resolveSystemPromptInjection`, so the
 * preview cannot drift from what ships.
 */
export function buildSystemPromptPreview(
  settings: SystemPromptInjectionSettings,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<SystemPromptPreviewEntry> {
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => {
      const support = systemPromptInjectionSupport(provider.driver);
      return {
        instanceId: provider.instanceId,
        driverKind: provider.driver,
        displayName: provider.displayName ?? provider.instanceId,
        support,
        text:
          support === "unsupported"
            ? undefined
            : resolveSystemPromptInjection(settings, {
                driverKind: provider.driver,
                instanceId: provider.instanceId,
              }),
      };
    });
}
