/**
 * ProviderSessionDirectory - Session ownership index across provider adapters.
 *
 * Tracks which provider owns each `sessionId` so `ProviderService` can route
 * session-scoped calls to the correct adapter. It is metadata only and does not
 * perform provider RPC or checkpoint operations.
 *
 * @module ProviderSessionDirectory
 */
import type { ProviderKind } from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ProviderAdapterError,
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ProviderSessionBinding {
  readonly sessionId: string;
  readonly provider: ProviderKind;
  readonly threadId?: string;
}

export type ProviderSessionDirectoryReadError =
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  /**
   * Record or update ownership for one provider session.
   */
  readonly upsert: (
    binding: ProviderSessionBinding,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  /**
   * Resolve the provider owner for a session id.
   */
  readonly getProvider: (
    sessionId: string,
  ) => Effect.Effect<ProviderKind, ProviderSessionDirectoryReadError>;

  /**
   * Resolve the tracked thread id for a session, if known.
   */
  readonly getThreadId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<string>, ProviderSessionDirectoryReadError>;

  /**
   * Remove a session binding.
   */
  readonly remove: (
    sessionId: string,
  ) => Effect.Effect<void, ProviderSessionDirectoryPersistenceError>;

  /**
   * List tracked session ids.
   */
  readonly listSessionIds: () => Effect.Effect<
    ReadonlyArray<string>,
    ProviderSessionDirectoryPersistenceError
  >;

  /**
   * Remove stale persisted sessions that are no longer active in adapters.
   *
   * Returns pruned session ids.
   */
  readonly reconcileWithAdapters: (
    adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    ProviderSessionDirectoryPersistenceError | ProviderAdapterError
  >;
}

/**
 * ProviderSessionDirectory - Service tag for session ownership lookup.
 */
export class ProviderSessionDirectory extends ServiceMap.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("provider/ProviderSessionDirectory") {}
