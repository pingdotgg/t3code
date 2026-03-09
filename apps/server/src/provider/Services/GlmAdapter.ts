/**
 * GlmAdapter - GLM implementation of the generic provider adapter contract.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "glm"` context.
 *
 * @module GlmAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * GlmAdapterShape - Service API for the GLM provider adapter.
 */
export interface GlmAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "glm";
}

/**
 * GlmAdapter - Service tag for GLM provider adapter operations.
 */
export class GlmAdapter extends ServiceMap.Service<GlmAdapter, GlmAdapterShape>()(
  "t3/provider/Services/GlmAdapter",
) {}
