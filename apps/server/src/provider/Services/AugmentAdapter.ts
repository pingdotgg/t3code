/**
 * AugmentAdapter - Augment implementation of the generic provider adapter contract.
 *
 * This service owns Augment ACP (Agent Client Protocol) process / JSON-RPC semantics
 * and emits Augment provider events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "augment"` context.
 *
 * @module AugmentAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AugmentAdapterShape - Service API for the Augment provider adapter.
 */
export interface AugmentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "augment";
}

/**
 * AugmentAdapter - Service tag for Augment provider adapter operations.
 */
export class AugmentAdapter extends ServiceMap.Service<AugmentAdapter, AugmentAdapterShape>()(
  "t3/provider/Services/AugmentAdapter",
) {}

