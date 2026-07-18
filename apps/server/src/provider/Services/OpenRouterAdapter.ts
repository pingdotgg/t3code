/**
 * OpenRouterAdapter — shape type for the OpenRouter provider adapter.
 *
 * The driver model ({@link ../Drivers/OpenRouterDriver}) bundles one adapter
 * per instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module OpenRouterAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenRouterAdapterShape — per-instance OpenRouter adapter contract.
 */
export interface OpenRouterAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
