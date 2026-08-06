/**
 * OpenClawAdapter — shape type for the OpenClaw provider adapter.
 *
 * The driver model ({@link ../Drivers/OpenClawDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module OpenClawAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenClawAdapterShape — per-instance OpenClaw adapter contract.
 */
export interface OpenClawAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
