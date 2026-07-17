/**
 * KiroAdapter — shape type for the Kiro ACP provider adapter.
 *
 * @module KiroAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
