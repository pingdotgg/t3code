/**
 * OpenCode2Adapter — shape type for the OpenCode 2 provider adapter.
 *
 * Naming anchor mirroring {@link ./OpenCodeAdapter.ts} for the v2 driver
 * bundle. The adapter talks to the machine's OpenCode 2 background service
 * (or an explicit external server) through `@opencode/client/effect`.
 *
 * @module OpenCode2Adapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenCode2AdapterShape — per-instance OpenCode 2 adapter contract.
 */
export interface OpenCode2AdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
