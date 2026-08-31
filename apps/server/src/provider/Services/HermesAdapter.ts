import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface HermesAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
