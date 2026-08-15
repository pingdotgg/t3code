/**
 * OmpAdapter — per-instance adapter shape for OMP's ACP runtime.
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
