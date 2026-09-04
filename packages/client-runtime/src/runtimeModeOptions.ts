import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";

export type ProviderRuntimeModeCapabilities = Pick<ServerProvider, "supportedRuntimeModes">;

/**
 * Read the provider capability without making older server snapshots opt in
 * to a new restriction. An omitted field means the provider keeps the full
 * product runtime-mode menu.
 */
export function getProviderSupportedRuntimeModes(
  provider: ProviderRuntimeModeCapabilities | null | undefined,
): ReadonlyArray<RuntimeMode> | undefined {
  return provider?.supportedRuntimeModes;
}

/** Filter a runtime-mode menu while preserving its product-defined order. */
export function filterRuntimeModeOptions<T extends RuntimeMode | { readonly mode: RuntimeMode }>(
  options: ReadonlyArray<T>,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): ReadonlyArray<T> {
  if (supportedRuntimeModes === undefined) return options;
  const supported = new Set(supportedRuntimeModes);
  return options.filter((option) =>
    supported.has(typeof option === "string" ? option : option.mode),
  );
}
