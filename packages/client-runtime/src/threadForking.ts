import { ProviderDriverKind } from "@t3tools/contracts";

const SELECTED_RESPONSE_FORK_DRIVERS = new Set<ProviderDriverKind>([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("opencode"),
]);

export function supportsSelectedResponseFork(
  driverKind: ProviderDriverKind | null | undefined,
): boolean {
  return driverKind !== null && driverKind !== undefined
    ? SELECTED_RESPONSE_FORK_DRIVERS.has(driverKind)
    : false;
}
