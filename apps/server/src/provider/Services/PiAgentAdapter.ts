/**
 * PiAgentAdapter — shape type for the Pi provider adapter.
 *
 * The driver model ({@link ../Drivers/PiAgentDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module PiAgentAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * PiAgentAdapterShape — per-instance Pi adapter contract.
 */
export interface PiAgentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
