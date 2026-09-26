/**
 * PiAdapter — shape type for the Pi coding agent adapter.
 *
 * The driver model ({@link ../Drivers/PiDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * PiAdapterShape — per-instance Pi adapter contract.
 */
export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
