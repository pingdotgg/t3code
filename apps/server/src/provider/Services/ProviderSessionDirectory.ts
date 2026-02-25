/**
 * ProviderSessionDirectory - Session ownership index across provider adapters.
 *
 * Tracks which provider owns each `sessionId` so `ProviderService` can route
 * session-scoped calls to the correct adapter. It is metadata only and does not
 * perform provider RPC or checkpoint operations.
 *
 * @module ProviderSessionDirectory
 */
import type {
  ProviderKind,
  ProviderSessionId,
  ProviderSessionRuntimeStatus,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderSessionBinding {
  readonly sessionId: ProviderSessionId;
  readonly provider: ProviderKind;
  readonly threadId?: ThreadId;
  readonly adapterKey?: string;
  readonly providerThreadId?: ProviderThreadId | null;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
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
    sessionId: ProviderSessionId,
  ) => Effect.Effect<ProviderKind, ProviderSessionDirectoryReadError>;

  /**
   * Resolve the tracked thread id for a session, if known.
   */
  readonly getThreadId: (
    sessionId: ProviderSessionId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProviderSessionDirectoryReadError>;

  /**
   * Remove a session binding.
   */
  readonly remove: (
    sessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderSessionDirectoryPersistenceError>;

  /**
   * List tracked session ids.
   */
  readonly listSessionIds: () => Effect.Effect<
    ReadonlyArray<ProviderSessionId>,
    ProviderSessionDirectoryPersistenceError
  >;
}

/**
 * ProviderSessionDirectory - Service tag for session ownership lookup.
 */
export class ProviderSessionDirectory extends ServiceMap.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("provider/ProviderSessionDirectory") {}
