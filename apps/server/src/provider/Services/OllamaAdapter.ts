/**
 * OllamaAdapter — shape type for the Ollama provider adapter.
 *
 * The driver model ({@link ../Drivers/OllamaDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module OllamaAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OllamaAdapterShape — per-instance Ollama adapter contract.
 */
export interface OllamaAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}