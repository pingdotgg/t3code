import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DevinAdapterShape — per-instance Devin adapter contract.
 */
export interface DevinAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
