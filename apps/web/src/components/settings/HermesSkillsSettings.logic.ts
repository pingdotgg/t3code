import type {
  HermesSkillsProviderProjection,
  HermesSkillsReloadResponse,
} from "@t3tools/contracts";

export function formatSkillsReloadSummary(result: HermesSkillsReloadResponse): string {
  const parts = [`${result.added.length} added`, `${result.removed.length} removed`];
  if (result.total !== null) parts.push(`${result.total} total`);
  return parts.join(", ");
}

export function formatSkillNames(names: ReadonlyArray<string>): string | null {
  return names.length === 0 ? null : names.join(", ");
}

export function skillsBlockedDiagnostic(provider: HermesSkillsProviderProjection): string | null {
  if (provider.status === "ready") return null;
  return provider.diagnostics[0] ?? "Hermes skills are unavailable for this provider.";
}

/**
 * The capability-negotiation footer only applies when a connected gateway is
 * actually blocked on capability negotiation. Providers that could not be
 * reached at all (status "error", or configuration problems without a
 * protocol classification) already carry an accurate per-provider diagnostic.
 */
export function skillsNegotiationFooter(
  providers: ReadonlyArray<HermesSkillsProviderProjection>,
): string | null {
  if (providers.length === 0 || providers.some((provider) => provider.status === "ready")) {
    return null;
  }
  return providers.some(
    (provider) => provider.status === "unavailable" && provider.protocolClassification !== null,
  )
    ? "Skills access requires a gateway with a negotiated skills.manage capability."
    : null;
}
