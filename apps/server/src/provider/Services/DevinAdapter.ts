/**
 * DevinAdapter — shape type for the Devin provider adapter.
 *
 * Mirrors {@link ./CursorAdapter.ts}: the driver model
 * ({@link ../Drivers/DevinDriver.ts}) bundles one adapter per instance as a
 * captured closure, so only the shape interface lives here.
 *
 * @module DevinAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DevinAdapterShape — per-instance Devin adapter contract. Carries a branded
 * driver kind as the nominal discriminant.
 */
export interface DevinAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
