/**
 * KiroAdapter — shape type for the Kiro provider adapter.
 *
 * The driver model ({@link ../Drivers/KiroDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module KiroAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * KiroAdapterShape — per-instance Kiro adapter contract.
 */
export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
