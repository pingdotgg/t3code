/**
 * CodexAdapter — shape type for the Codex provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/CodexDriver}) bundles one adapter per
 * instance as a captured closure instead. This module defines the adapter
 * shape and the compaction strategy used by its runtime and advertised command.
 *
 * @module CodexAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderCompactionStrategy } from "./ProviderAdapter.ts";

export const CODEX_COMPACTION = {
  type: "native",
  completionTimeout: "10 minutes",
} satisfies ProviderCompactionStrategy;

/**
 * CodexAdapterShape — per-instance Codex adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface CodexAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly uploadFeedback: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["uploadFeedback"]
  >;
}
