/**
 * GeminiAdapter - Gemini implementation of the generic provider adapter contract.
 *
 * This service owns Gemini CLI headless process / JSONL streaming semantics
 * and emits Gemini provider events. It does not perform cross-provider routing,
 * shared event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "gemini"` context.
 *
 * @module GeminiAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * GeminiAdapterShape - Service API for the Gemini provider adapter.
 */
export interface GeminiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "gemini";
}

/**
 * GeminiAdapter - Service tag for Gemini provider adapter operations.
 */
export class GeminiAdapter extends ServiceMap.Service<GeminiAdapter, GeminiAdapterShape>()(
  "t3/provider/Services/GeminiAdapter",
) {}
