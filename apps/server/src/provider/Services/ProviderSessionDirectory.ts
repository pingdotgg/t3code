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

import type { ProviderSessionNotFoundError, ProviderValidationError } from "../Errors.ts";

export interface ProviderSessionBinding {
  readonly sessionId: string;
  readonly provider: ProviderKind;
  readonly threadId?: string;
}

export interface ProviderSessionDirectoryShape {
  /**
   * Record or update ownership for one provider session.
   */
  readonly upsert: (
    binding: ProviderSessionBinding,
  ) => Effect.Effect<void, ProviderValidationError>;

  /**
   * Resolve the provider owner for a session id.
   */
  readonly getProvider: (
    sessionId: string,
  ) => Effect.Effect<ProviderKind, ProviderSessionNotFoundError>;

  /**
   * Resolve the tracked thread id for a session, if known.
   */
  readonly getThreadId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<string>, ProviderSessionNotFoundError>;

  /**
   * Remove a session binding.
   */
  readonly remove: (sessionId: string) => Effect.Effect<void>;

  /**
   * List tracked session ids.
   */
  readonly listSessionIds: () => Effect.Effect<ReadonlyArray<string>>;
}

/**
 * ProviderSessionDirectory - Service tag for session ownership lookup.
 */
export class ProviderSessionDirectory extends ServiceMap.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("provider/ProviderSessionDirectory") {}
