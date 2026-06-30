import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderUnsupportedError,
  type ProviderServiceError,
} from "./Errors.ts";

export type ProviderFallbackFailureKind =
  | "authentication"
  | "process"
  | "rate-limit"
  | "transport"
  | "unavailable";

export interface ProviderFallbackFailure {
  readonly kind: ProviderFallbackFailureKind;
  readonly message: string;
}

export interface ProviderFallbackSkip {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly reason: string;
}

export interface ProviderFallbackCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly modelSelection: ModelSelection;
  readonly provider: ServerProvider;
}

export interface ProviderFallbackPlan {
  readonly candidates: ReadonlyArray<ProviderFallbackCandidate>;
  readonly skipped: ReadonlyArray<ProviderFallbackSkip>;
}

const RATE_LIMIT_PATTERN =
  /\b(?:rate[ -]?limit|usage limit|quota|too many requests|resource exhausted|credits? exhausted|limit reached)\b/i;
const AUTH_PATTERN =
  /\b(?:unauthenticated|authentication|not authenticated|invalid (?:api )?key|expired token|login required|unauthorized|forbidden)\b/i;
const TRANSPORT_PATTERN =
  /\b(?:connection (?:closed|lost|refused|reset)|network|socket|timed? out|timeout|transport|broken pipe|econnreset|econnrefused|service unavailable|bad gateway|gateway timeout|http 5\d\d)\b/i;
const isProviderUnsupportedError = Schema.is(ProviderUnsupportedError);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);

function classifyMessage(message: string): ProviderFallbackFailure | undefined {
  if (RATE_LIMIT_PATTERN.test(message)) return { kind: "rate-limit", message };
  if (AUTH_PATTERN.test(message)) return { kind: "authentication", message };
  if (TRANSPORT_PATTERN.test(message)) return { kind: "transport", message };
  return undefined;
}

export function classifyProviderServiceFailure(
  cause: Cause.Cause<ProviderServiceError | unknown>,
): ProviderFallbackFailure | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  const error = failReason?.error;
  if (isProviderUnsupportedError(error)) {
    return { kind: "unavailable", message: error.message };
  }
  if (isProviderAdapterProcessError(error)) {
    return { kind: "process", message: error.detail };
  }
  if (isProviderAdapterRequestError(error)) {
    return classifyMessage(error.detail);
  }
  return error instanceof Error
    ? classifyMessage(error.message)
    : classifyMessage(Cause.pretty(cause));
}

export function classifyProviderRuntimeFailure(
  event: ProviderRuntimeEvent,
): ProviderFallbackFailure | undefined {
  if (event.type === "runtime.error") {
    if (event.payload.class === "transport_error") {
      return { kind: "transport", message: event.payload.message };
    }
    return classifyMessage(event.payload.message);
  }
  if (event.type === "session.exited" && event.payload.exitKind === "error") {
    const message = event.payload.reason ?? "Provider process exited unexpectedly.";
    return classifyMessage(message) ?? { kind: "process", message };
  }
  if (event.type === "turn.completed" && event.payload.state === "failed") {
    const message = event.payload.errorMessage ?? "Provider turn failed.";
    return classifyMessage(message);
  }
  return undefined;
}

export function providerFallbackDisplayName(provider: ServerProvider): string {
  return provider.displayName?.trim() || String(provider.instanceId);
}

export function planProviderFallback(input: {
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly requireCompatibleContinuation: boolean;
  readonly excludedInstanceIds?: ReadonlySet<ProviderInstanceId>;
}): ProviderFallbackPlan {
  const current = input.providers.find(
    (provider) => provider.instanceId === input.currentInstanceId,
  );
  if (!current) return { candidates: [], skipped: [] };

  const candidates: ProviderFallbackCandidate[] = [];
  const skipped: ProviderFallbackSkip[] = [];
  for (const provider of input.providers) {
    if (provider.instanceId === current.instanceId || provider.driver !== current.driver) continue;
    const displayName = providerFallbackDisplayName(provider);
    const skip = (reason: string) =>
      skipped.push({ instanceId: provider.instanceId, displayName, reason });
    const config = input.settings.providerInstances[provider.instanceId];

    if (input.excludedInstanceIds?.has(provider.instanceId)) {
      skip("This instance was already attempted during the current fallback chain.");
      continue;
    }

    if (config?.allowFallback === false) {
      skip("Automatic fallback is disabled for this instance.");
      continue;
    }
    if (!provider.enabled || provider.status === "disabled") {
      skip("The instance is disabled.");
      continue;
    }
    if (!provider.installed || !isProviderAvailable(provider) || provider.status === "error") {
      skip(provider.unavailableReason ?? provider.message ?? "The instance is unavailable.");
      continue;
    }
    if (!provider.models.some((model) => model.slug === input.modelSelection.model)) {
      skip(`Model '${input.modelSelection.model}' was not found on this instance.`);
      continue;
    }
    if (input.requireCompatibleContinuation) {
      const currentGroup = current.continuation?.groupKey;
      const candidateGroup = provider.continuation?.groupKey;
      if (!currentGroup || !candidateGroup || currentGroup !== candidateGroup) {
        skip(
          "The provider home directory or continuation store does not match the active instance.",
        );
        continue;
      }
    }

    candidates.push({
      instanceId: provider.instanceId,
      displayName,
      modelSelection: { ...input.modelSelection, instanceId: provider.instanceId },
      provider,
    });
  }
  return { candidates, skipped };
}
