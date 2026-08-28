/**
 * OmpAdapter — shape type for the OMP provider adapter.
 *
 * The driver model ({@link ../Drivers/OmpDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module OmpAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OmpAdapterShape — per-instance OMP adapter contract.
 */
export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
