/**
 * ClaudeCodeAdapter - Claude Code implementation of the generic provider adapter contract.
 *
 * Uses the Claude Agent SDK to manage session lifecycle, streaming turns,
 * approvals, and canonical runtime events for the shared provider layer.
 *
 * @module ClaudeCodeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudeCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeCode";
}

export class ClaudeCodeAdapter extends ServiceMap.Service<
  ClaudeCodeAdapter,
  ClaudeCodeAdapterShape
>()("t3/provider/Services/ClaudeCodeAdapter") {}
