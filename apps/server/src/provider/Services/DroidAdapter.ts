/**
 * DroidAdapter — shape type for the Factory Droid provider adapter.
 *
 * The driver model ({@link ../Drivers/DroidDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module DroidAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DroidAdapterShape — per-instance Droid adapter contract.
 */
export interface DroidAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
