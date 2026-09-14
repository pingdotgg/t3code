/**
 * AuggieAdapter — shape type for the Auggie provider adapter.
 *
 * The driver model ({@link ../Drivers/AuggieDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module AuggieAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AuggieAdapterShape — per-instance Auggie adapter contract.
 */
export interface AuggieAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
