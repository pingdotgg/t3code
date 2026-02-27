/**
 * CodexAdapter - Codex implementation of the generic provider adapter contract.
 *
 * This service owns Codex app-server process / JSON-RPC semantics and emits
 * Codex provider events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "codex"` context.
 *
 * @module CodexAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CodexAdapterShape - Service API for the Codex provider adapter.
 */
export interface CodexAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "codex";
}

/**
 * CodexAdapter - Service tag for Codex provider adapter operations.
 */
export class CodexAdapter extends ServiceMap.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Services/CodexAdapter",
) {}
