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

const RUNTIME_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const SAFEST_RUNTIME_MODE: RuntimeMode = "approval-required";

/**
 * Keep a staged/current mode valid for the selected provider. Missing
 * capability metadata is intentionally treated as the full product menu for
 * compatibility with older server snapshots.
 */
export function reconcileRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  if (supportedRuntimeModes === undefined || supportedRuntimeModes.includes(runtimeMode)) {
    return runtimeMode;
  }

  const supported = new Set(supportedRuntimeModes);
  return (
    RUNTIME_MODE_ORDER.find((mode) => supported.has(mode)) ??
    // An explicit empty capability list cannot produce a provider-valid
    // replacement. Use the least-permissive product mode rather than
    // retaining a possibly wider selection or falling back to full access.
    SAFEST_RUNTIME_MODE
  );
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
