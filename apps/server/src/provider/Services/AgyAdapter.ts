/**
 * AgyAdapter — shape type for the Antigravity (agy) provider adapter.
 *
 * The driver model ({@link ../Drivers/AgyDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module AgyAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AgyAdapterShape — per-instance Antigravity adapter contract.
 */
export interface AgyAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
