/**
 * ZaiAdapter — shape type for the Z.ai provider adapter.
 *
 * Z.ai reuses the Claude runtime adapter (see {@link ../Layers/ClaudeAdapter})
 * pointed at Z.ai's Anthropic-compatible endpoint, so this module only
 * retains the shape interface as a naming anchor for the driver bundle.
 *
 * @module ZaiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ZaiAdapterShape — per-instance Z.ai adapter contract.
 */
export interface ZaiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
