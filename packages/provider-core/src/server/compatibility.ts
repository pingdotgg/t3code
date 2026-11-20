import type { ProviderDriverKind, ServerProviderCompatibilityAdvisory } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Rates a detected provider version against the host's compatibility policy. */
export type ProviderCompatibilityLookup = (
  driver: ProviderDriverKind,
  version: string,
) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;

export const noCompatibilityPolicy: ProviderCompatibilityLookup = () => Effect.undefined;

/** The one message for a version the policy rates `broken`; `action` names how it is updated. */
export function brokenVersionDetail(input: {
  readonly name: string;
  readonly version: string;
  readonly advisory: ServerProviderCompatibilityAdvisory | undefined;
  readonly action?: string;
}): string | undefined {
  if (input.advisory?.status !== "broken") return undefined;
  const target =
    input.advisory.recommendedVersion ?? input.advisory.recommendedRange ?? "a newer version";
  return `${input.name} ${input.version} does not work with this T3 Code release. ${input.action ?? `Update ${input.name}`} to ${target}, then retry.`;
}
