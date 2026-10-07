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

/** Keep a directly paired machine pinned while its initial connection completes. */
export function resolveOnboardingTargetEnvironment<TEnvironment extends OnboardingEnvironment>({
  mode,
  environments,
  primaryEnvironment,
  pairedEnvironmentId,
}: {
  readonly mode: "local" | "connect" | "direct";
  readonly environments: ReadonlyArray<TEnvironment>;
  readonly primaryEnvironment: TEnvironment | null;
  readonly pairedEnvironmentId: EnvironmentId | null;
}): TEnvironment | null {
  if (mode === "direct" && pairedEnvironmentId !== null) {
    const pairedEnvironment = environments.find(
      (environment) => environment.environmentId === pairedEnvironmentId,
    );
    return pairedEnvironment?.connection.phase === "connected" ? pairedEnvironment : null;
  }

  const connectedRelayEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && isOnboardingRelayEnvironment(environment),
  );

  if (mode === "connect" && connectedRelayEnvironments.length > 0) {
    return connectedRelayEnvironments[connectedRelayEnvironments.length - 1] ?? null;
  }

  if (primaryEnvironment?.connection.phase === "connected") {
    return primaryEnvironment;
  }

  return mode === "local" ? null : (connectedRelayEnvironments[0] ?? null);
}

/**
 * The computers the wizard sets up from the user's selection. Continue waits
 * only on a first connection attempt, which settles on its own. Selected
 * computers that are switched off, offline, failing, or unsupported are skipped
 * so they can never lock the user out of onboarding.
 */
export function resolveOnboardingSetup(
  environments: ReadonlyArray<Pick<OnboardingEnvironment, "environmentId" | "connection">>,
  selectedIds: ReadonlySet<EnvironmentId>,
): { readonly ready: boolean; readonly environmentIds: ReadonlyArray<EnvironmentId> } {
  const selected = environments.filter((environment) => selectedIds.has(environment.environmentId));
  const environmentIds = selected
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  const settling = selected.some((environment) => environment.connection.phase === "connecting");
  return { ready: environmentIds.length > 0 && !settling, environmentIds };
}
