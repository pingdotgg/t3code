import { type ConnectionCatalogEntry, hasRelayRoute } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

interface OnboardingEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: string };
  readonly entry: Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">;
}

export function isOnboardingRelayEnvironment(
  environment: Pick<OnboardingEnvironment, "entry">,
): boolean {
  return hasRelayRoute(environment.entry);
}

/**
 * Continue waits only on a first connection attempt, which settles on its own.
 * Selected computers that are switched off, offline, failing, or unsupported
 * are skipped so they can never lock the user out of onboarding.
 */
export function resolveOnboardingSetup(
  environments: ReadonlyArray<Pick<OnboardingEnvironment, "environmentId" | "connection">>,
  selectedIds: ReadonlySet<EnvironmentId>,
): {
  readonly ready: boolean;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly skippedIds: ReadonlyArray<EnvironmentId>;
} {
  const selected = environments.filter((environment) => selectedIds.has(environment.environmentId));
  const idsInPhase = (keep: (phase: string) => boolean) =>
    selected
      .filter((environment) => keep(environment.connection.phase))
      .map((environment) => environment.environmentId);
  const environmentIds = idsInPhase((phase) => phase === "connected");
  const settling = selected.some((environment) => environment.connection.phase === "connecting");
  return {
    ready: environmentIds.length > 0 && !settling,
    environmentIds,
    skippedIds: idsInPhase((phase) => phase !== "connected" && phase !== "connecting"),
  };
}
