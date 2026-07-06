import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderProjectCapabilitiesError } from "./Errors.ts";

function describeCapabilityProbeFailure(cause: unknown): string {
  if (
    cause &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return cause.message;
  }
  return "Provider project capability probe failed.";
}

export function makeProviderProjectCapabilitiesError(input: {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly cause: unknown;
}): ProviderProjectCapabilitiesError {
  return new ProviderProjectCapabilitiesError({
    provider: input.provider,
    instanceId: input.instanceId,
    cwd: input.cwd,
    detail: describeCapabilityProbeFailure(input.cause),
    cause: input.cause,
  });
}
