/**
 * GrokAdapter — shape type for the Grok provider adapter.
 *
 * The driver model ({@link ../Drivers/GrokDriver}) bundles one adapter per
 * instance as a captured closure. This module defines the adapter shape and
 * the compaction strategy used by its runtime and advertised command.
 *
 * @module GrokAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderCompactionStrategy } from "./ProviderAdapter.ts";

export const GROK_COMPACTION = {
  type: "slash-command",
  command: "/compact",
  completionTimeout: "10 minutes",
} satisfies ProviderCompactionStrategy;

/**
 * GrokAdapterShape — per-instance Grok adapter contract.
 */
export interface GrokAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
