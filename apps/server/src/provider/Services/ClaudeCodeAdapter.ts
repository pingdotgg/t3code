/**
 * ClaudeCodeAdapter - Claude Code implementation of the generic provider adapter contract.
 *
 * This service owns Claude Agent SDK process/streaming semantics and emits
 * canonical provider runtime events. It does not perform cross-provider routing,
 * shared event fan-out, or checkpoint orchestration.
 *
 * @module ClaudeCodeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClaudeCodeAdapterShape - Service API for the Claude Code provider adapter.
 */
export interface ClaudeCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeCode";
}

/**
 * ClaudeCodeAdapter - Service tag for Claude Code provider adapter operations.
 */
export class ClaudeCodeAdapter extends ServiceMap.Service<
  ClaudeCodeAdapter,
  ClaudeCodeAdapterShape
>()("t3/provider/Services/ClaudeCodeAdapter") {}
