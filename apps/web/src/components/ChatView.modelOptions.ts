import type { ModelCapabilities, ProviderOptionSelection } from "@t3tools/contracts";

/**
 * Filter stored option selections down to those the next model also exposes.
 * Used when switching models so a reasoning-effort choice carries over to a
 * model that supports the same option descriptor, while options the new model
 * does not have are dropped instead of sent blindly. Returns `undefined` when
 * nothing survives so callers can omit the `options` field entirely.
 */
export function preserveCompatibleOptions(
  currentOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  nextCaps: ModelCapabilities | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!currentOptions || currentOptions.length === 0) return undefined;
  const descriptorIds = new Set(
    (nextCaps?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
  );
  if (descriptorIds.size === 0) return undefined;
  const preserved = currentOptions.filter((option) => descriptorIds.has(option.id));
  return preserved.length > 0 ? preserved : undefined;
}
