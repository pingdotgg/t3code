/**
 * OmpAdapter — shape type for the Oh My Pi (`omp`) provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/OmpDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module OmpAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * Cursor persisted on a `ProviderSession` so a later `startSession` reopens
 * the same omp session through `session/load`. Versioned because the
 * adapter refuses cursors it cannot read rather than resuming the wrong
 * conversation.
 */
export interface OmpResumeCursor {
  readonly schemaVersion: number;
  readonly sessionId: string;
}

/**
 * OmpAdapterShape — per-instance Oh My Pi adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export type OmpAdapterShape = ProviderAdapterShape<ProviderAdapterError>;
