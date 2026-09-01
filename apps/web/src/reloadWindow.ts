import type { EnvironmentId } from "@t3tools/contracts";

export async function refreshProvidersAndReload(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly refreshProviders: (environmentId: EnvironmentId) => Promise<unknown>;
  readonly onRefreshStart: () => void;
  readonly reload: () => void;
}): Promise<void> {
  input.onRefreshStart();
  await Promise.allSettled(
    input.environmentIds.map((environmentId) => input.refreshProviders(environmentId)),
  );
  input.reload();
}
