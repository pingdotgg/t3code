/**
 * PrimeAgentAdapter - shape type for the Prime Agent provider adapter.
 *
 * The driver captures one adapter per configured instance, so this module
 * only names the provider-specific adapter contract.
 *
 * @module PrimeAgentAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/** PrimeAgentAdapterShape - per-instance Prime Agent adapter contract. */
export interface PrimeAgentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
