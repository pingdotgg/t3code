/**
 * AntigravityAdapter — shape type for the Antigravity provider adapter.
 *
 * The driver model ({@link ../Drivers/AntigravityDriver}) bundles one adapter
 * per instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module AntigravityAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AntigravityAdapterShape — per-instance Antigravity adapter contract.
 */
export interface AntigravityAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
