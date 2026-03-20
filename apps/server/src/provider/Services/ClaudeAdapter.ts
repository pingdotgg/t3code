/**
 * ClaudeAdapter - Claude Agent implementation of the generic provider adapter contract.
 *
 * This service owns Claude runtime/session semantics and emits canonical
 * provider runtime events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "claudeAgent"` context.
 *
 * @module ClaudeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClaudeAdapterShape - Service API for the Claude Agent provider adapter.
 */
export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeAgent";
}

/**
 * ClaudeAdapter - Service tag for Claude Agent provider adapter operations.
 */
export class ClaudeAdapter extends ServiceMap.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Services/ClaudeAdapter",
) {}
