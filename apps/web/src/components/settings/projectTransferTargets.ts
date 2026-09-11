import type { EnvironmentId } from "@t3tools/contracts";

type TransferEnvironment = {
  environmentId: EnvironmentId;
  connection: { phase: string };
  serverConfig?: { environment: { capabilities: { projectTransfer?: boolean } } } | null;
};

/** Only connected, compatible machines without a checkout in this project group. */
export function projectTransferTargets<T extends TransferEnvironment>(
  environments: readonly T[],
  checkouts: readonly { environmentId: EnvironmentId }[],
): T[] {
  const occupied = new Set(checkouts.map((checkout) => checkout.environmentId));
  return environments.filter(
    (environment) =>
      !occupied.has(environment.environmentId) &&
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.projectTransfer === true,
  );
}
