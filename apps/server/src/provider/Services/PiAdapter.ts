/**
 * PiAdapter — shape type for the Pi provider adapter.
 *
 * Mirrors the other per-driver shape aliases: the driver bundles one
 * adapter per instance as a captured closure, so there is no Context tag —
 * only the shape interface as a naming anchor.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
