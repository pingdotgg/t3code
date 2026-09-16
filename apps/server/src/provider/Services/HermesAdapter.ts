/**
 * HermesAdapter — shape type for the Hermes provider adapter.
 *
 * The driver model ({@link ../Drivers/HermesDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module HermesAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * HermesAdapterShape — per-instance Hermes adapter contract.
 */
export interface HermesAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
