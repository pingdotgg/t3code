/**
 * DevinAdapter — shape type for the Devin provider adapter.
 *
 * The driver model ({@link ../Drivers/DevinDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module DevinAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DevinAdapterShape — per-instance Devin adapter contract.
 */
export interface DevinAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
