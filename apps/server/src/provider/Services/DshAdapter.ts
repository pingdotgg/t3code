/**
 * DshAdapter — shape type for the DSH (deepseek-harness) provider adapter.
 *
 * The driver model ({@link ../Drivers/DshDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module DshAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DshAdapterShape — per-instance DSH adapter contract.
 */
export interface DshAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
