/**
 * CursorAdapter — shape type for the Cursor provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/CursorDriver}) bundles one adapter per
 * instance as a captured closure instead. This module defines the adapter
 * shape and the compaction strategy used by its runtime and advertised command.
 *
 * @module CursorAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderCompactionStrategy } from "./ProviderAdapter.ts";

export const CURSOR_COMPACTION = {
  type: "slash-command",
  command: "/compress",
  completionTimeout: "10 minutes",
} satisfies ProviderCompactionStrategy;

/**
 * CursorAdapterShape — per-instance Cursor adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface CursorAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
