import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpencodeAdapterShape - Service API for the Opencode provider adapter.
 */
export interface OpencodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

/**
 * OpencodeAdapter - Service tag for Opencode provider adapter operations.
 */
export class OpencodeAdapter extends ServiceMap.Service<OpencodeAdapter, OpencodeAdapterShape>()(
  "t3/provider/Services/OpencodeAdapter",
) {}
