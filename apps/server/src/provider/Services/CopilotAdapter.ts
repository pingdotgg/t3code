/**
 * CopilotAdapter — shape type for the GitHub Copilot provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/CopilotDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module CopilotAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CopilotAdapterShape — per-instance GitHub Copilot adapter contract.
 */
export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
