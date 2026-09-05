/**
 * OpenCodeAdapter — shape type for the OpenCode provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/OpenCodeDriver}) bundles one adapter per
 * instance as a captured closure instead. This module defines the adapter
 * shape and the compaction strategy used by its runtime and advertised command.
 *
 * @module OpenCodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderCompactionStrategy } from "./ProviderAdapter.ts";

export const OPENCODE_COMPACTION = {
  type: "native",
  completionTimeout: "10 minutes",
} satisfies ProviderCompactionStrategy;

/**
 * OpenCodeAdapterShape — per-instance OpenCode adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
