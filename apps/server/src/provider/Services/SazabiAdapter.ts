/**
 * SazabiAdapter — shape type for the Sazabi provider adapter.
 *
 * The driver model ({@link ../Drivers/SazabiDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module SazabiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * SazabiAdapterShape — per-instance Sazabi adapter contract.
 */
export interface SazabiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
