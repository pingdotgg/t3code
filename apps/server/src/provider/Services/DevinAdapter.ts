/**
 * Per-instance adapter contract for the first-party Devin CLI driver.
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DevinAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
