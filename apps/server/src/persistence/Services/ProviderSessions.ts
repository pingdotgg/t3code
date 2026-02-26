/**
 * ProviderSessionRepository - Repository interface for provider session lookup.
 *
 * Owns persistence operations that map internal sessions to provider kinds and
 * optional thread ownership.
 *
 * @module ProviderSessionRepository
 */
import type { ProviderKind, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderSessionRepositoryError } from "../Errors.ts";

export interface ProviderSessionEntry {
  readonly sessionId: ProviderSessionId;
  readonly provider: ProviderKind;
  readonly threadId?: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertProviderSessionInput {
  readonly sessionId: ProviderSessionId;
  readonly provider: ProviderKind;
  readonly threadId?: ThreadId;
}

export interface DeleteProviderSessionInput {
  readonly sessionId: ProviderSessionId;
}

export interface GetProviderSessionInput {
  readonly sessionId: ProviderSessionId;
}

/**
 * ProviderSessionRepositoryShape - Service API for provider-session records.
 */
export interface ProviderSessionRepositoryShape {
  /**
   * Insert or replace a provider-session row.
   *
   * Upserts by `sessionId`.
   */
  readonly upsertSession: (
    input: UpsertProviderSessionInput,
  ) => Effect.Effect<void, ProviderSessionRepositoryError>;

  /**
   * Read a provider-session row by session id.
   */
  readonly getSession: (
    input: GetProviderSessionInput,
  ) => Effect.Effect<Option.Option<ProviderSessionEntry>, ProviderSessionRepositoryError>;

  /**
   * List all provider-session rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<ProviderSessionEntry>,
    ProviderSessionRepositoryError
  >;

  /**
   * Delete a provider-session row by session id.
   */
  readonly deleteSession: (
    input: DeleteProviderSessionInput,
  ) => Effect.Effect<void, ProviderSessionRepositoryError>;
}

/**
 * ProviderSessionRepository - Service tag for provider-session persistence.
 */
export class ProviderSessionRepository extends ServiceMap.Service<
  ProviderSessionRepository,
  ProviderSessionRepositoryShape
>()("persistence/ProviderSessionRepository") {}
