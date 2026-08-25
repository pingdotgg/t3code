/**
 * FxAdapter — shape type for the Fx provider adapter.
 *
 * The driver model ({@link ../Drivers/FxDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module FxAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * FxAdapterShape — per-instance Fx adapter contract.
 */
export interface FxAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
