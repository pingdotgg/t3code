import type { ProviderDriverKind } from "@t3tools/contracts";

export function usageLimitOrder(
  saved: readonly ProviderDriverKind[],
  available: readonly ProviderDriverKind[],
): ProviderDriverKind[] {
  return [...new Set([...saved, ...available])];
}
