/**
 * KimiAdapter — shape type for the Kimi Code provider adapter.
 *
 * The driver model ({@link ../Drivers/KimiDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module KimiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * KimiAdapterShape — per-instance Kimi Code adapter contract.
 */
export interface KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
