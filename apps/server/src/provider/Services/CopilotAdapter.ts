/**
 * CopilotAdapter — shape type for the GitHub Copilot provider adapter.
 *
 * @module CopilotAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CopilotAdapterShape — per-instance Copilot adapter contract.
 */
export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
