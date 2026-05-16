/**
 * OllamaAdapter — shape type for the Ollama provider adapter.
 *
 * @module OllamaAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OllamaAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
