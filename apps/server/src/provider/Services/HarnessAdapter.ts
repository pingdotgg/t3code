/**
 * HarnessAdapter — shape type for the Harness HTTP provider adapter.
 *
 * @module HarnessAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface HarnessAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
