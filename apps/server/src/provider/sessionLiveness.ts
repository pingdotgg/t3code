import type { ProviderSession } from "@t3tools/contracts";

export function providerSessionConfirmsActiveTurn(
  session: ProviderSession | null | undefined,
): boolean {
  return session !== null && session !== undefined
    ? session.status === "running" || session.activeTurnId != null
    : false;
}
