import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

interface OnboardingEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: string };
  readonly entry: { readonly target: ConnectionTarget };
}

export function isOnboardingRelayEnvironment(
  environment: Pick<OnboardingEnvironment, "entry">,
): boolean {
  return environment.entry.target._tag === "RelayConnectionTarget";
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
