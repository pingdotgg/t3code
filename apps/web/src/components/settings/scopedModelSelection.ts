import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

export const SCOPED_MODEL_SETTING_KEYS = [
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "speechPostProcessingModelSelection",
] as const;

const NON_SUBSCRIPTION_CLAUDE_AUTH = new Set(["apiKey", "bedrock", "customEndpoint"]);

/** Only a verified subscription login identifies who pays; names and instance IDs are machine-local. */
function subscriptionAccount(provider: ServerProvider): string | null {
  const { driver, auth } = provider;
  if (auth.status !== "authenticated" || !auth.type || !auth.email || !auth.workspaceId) {
    return null;
  }
  const subscription =
    driver === "codex"
      ? auth.type === "chatgpt"
      : driver === "claudeAgent" && !NON_SUBSCRIPTION_CLAUDE_AUTH.has(auth.type);
  return subscription
    ? JSON.stringify([driver, auth.type, auth.email.toLowerCase(), auth.workspaceId])
    : null;
}

/**
 * The destination instance for a source instance: the same ID and driver, else the one
 * subscription account that matches it uniquely in both environments.
 */
export function resolveScopedModelInstanceId(
  instanceId: ProviderInstanceId,
  sourceProviders: readonly ServerProvider[],
  destinationProviders: readonly ServerProvider[],
): ProviderInstanceId | null {
  const source = sourceProviders.find((provider) => provider.instanceId === instanceId);
  if (!source) return null;
  if (
    destinationProviders.some(
      (provider) => provider.instanceId === instanceId && provider.driver === source.driver,
    )
  ) {
    return instanceId;
  }
  const account = subscriptionAccount(source);
  if (account === null) return null;
  const matches = (providers: readonly ServerProvider[]) =>
    providers.filter((provider) => subscriptionAccount(provider) === account);
  const destination = matches(destinationProviders);
  return destination.length === 1 && matches(sourceProviders).length === 1
    ? destination[0]!.instanceId
    : null;
}

export function scopedModelSelectionsEqual(
  first: ModelSelection | null,
  firstProviders: readonly ServerProvider[],
  second: ModelSelection | null,
  secondProviders: readonly ServerProvider[],
): boolean {
  if (Equal.equals(first, second)) return true;
  if (first === null || second === null || first.instanceId === second.instanceId) return false;
  return (
    resolveScopedModelInstanceId(first.instanceId, firstProviders, secondProviders) ===
      second.instanceId &&
    resolveScopedModelInstanceId(second.instanceId, secondProviders, firstProviders) ===
      first.instanceId &&
    Equal.equals({ ...first, instanceId: second.instanceId }, second)
  );
}
