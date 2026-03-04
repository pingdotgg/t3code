/**
 * ProviderSessionRuntimeRepository - Repository interface for provider runtime sessions.
 *
 * Owns persistence operations for provider runtime metadata and resume cursors.
 *
 * @module ProviderSessionRuntimeRepository
 */
import {
  IsoDateTime,
  ProviderSessionId,
  ProviderSessionRuntimeStatus,
  ProviderThreadId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderSessionRuntimeRepositoryError } from "../Errors.ts";

export const ProviderSessionRuntime = Schema.Struct({
  providerSessionId: ProviderSessionId,
  threadId: ThreadId,
  providerName: Schema.String,
  adapterKey: Schema.String,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
});
export type ProviderSessionRuntime = typeof ProviderSessionRuntime.Type;

export const GetProviderSessionRuntimeInput = Schema.Struct({
  providerSessionId: ProviderSessionId,
});
export type GetProviderSessionRuntimeInput = typeof GetProviderSessionRuntimeInput.Type;

export const DeleteProviderSessionRuntimeInput = Schema.Struct({
  providerSessionId: ProviderSessionId,
});
export type DeleteProviderSessionRuntimeInput = typeof DeleteProviderSessionRuntimeInput.Type;

/**
 * ProviderSessionRuntimeRepositoryShape - Service API for provider runtime records.
 */
export interface ProviderSessionRuntimeRepositoryShape {
  /**
   * Insert or replace a provider runtime row.
   *
   * Upserts by `providerSessionId`, including JSON payload/cursor fields.
   */
  readonly upsert: (
    runtime: ProviderSessionRuntime,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  /**
   * Read provider runtime state by provider session id.
   */
  readonly getBySessionId: (
    input: GetProviderSessionRuntimeInput,
  ) => Effect.Effect<Option.Option<ProviderSessionRuntime>, ProviderSessionRuntimeRepositoryError>;

  /**
   * List all provider runtime rows.
   *
   * Returned in ascending last-seen order.
   */
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProviderSessionRuntime>,
    ProviderSessionRuntimeRepositoryError
  >;

  /**
   * Delete provider runtime state by provider session id.
   */
  readonly deleteBySessionId: (
    input: DeleteProviderSessionRuntimeInput,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;
}

/**
 * ProviderSessionRuntimeRepository - Service tag for provider runtime persistence.
 */
export class ProviderSessionRuntimeRepository extends ServiceMap.Service<
  ProviderSessionRuntimeRepository,
  ProviderSessionRuntimeRepositoryShape
>()("t3/persistence/Services/ProviderSessionRuntime/ProviderSessionRuntimeRepository") {}
