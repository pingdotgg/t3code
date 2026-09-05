/**
 * ClaudeAdapter — shape type for the Claude provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/ClaudeDriver}) bundles one adapter per
 * instance as a captured closure instead. This module defines the adapter
 * shape and the compaction strategy used by its runtime and advertised command.
 *
 * @module ClaudeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderCompactionStrategy } from "./ProviderAdapter.ts";

export const CLAUDE_COMPACTION = {
  type: "slash-command",
  command: "/compact",
  completionTimeout: "10 minutes",
} satisfies ProviderCompactionStrategy;

/**
 * ClaudeAdapterShape — per-instance Claude adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
