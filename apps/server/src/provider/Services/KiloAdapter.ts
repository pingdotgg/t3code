/**
 * KiloAdapter — shape type for the Kilo provider adapter.
 *
 * @module KiloAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * KiloAdapterShape — per-instance Kilo adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface KiloAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
