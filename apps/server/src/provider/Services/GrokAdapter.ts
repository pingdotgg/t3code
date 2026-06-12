/**
 * GrokAdapter — shape type for the Grok provider adapter.
 *
 * The driver model ({@link ../Drivers/GrokDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module GrokAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * GrokAdapterShape — per-instance Grok adapter contract.
 */
export interface GrokAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
