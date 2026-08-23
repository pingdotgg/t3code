import type { EnvironmentId } from "@t3tools/contracts";

interface OnboardingEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: string };
  readonly entry: { readonly target: { readonly _tag: string } };
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

  const connectedRemotes = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  if (mode !== "local" && connectedRemotes.length > 0) {
    return connectedRemotes[connectedRemotes.length - 1] ?? null;
  }

  if (primaryEnvironment?.connection.phase === "connected") {
    return primaryEnvironment;
  }

  return mode === "local" ? null : (connectedRemotes[0] ?? null);
}
