import type { ProviderKind } from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderSessionRepositoryError } from "../Errors.ts";

export interface ProviderSessionEntry {
  readonly sessionId: string;
  readonly provider: ProviderKind;
  readonly threadId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertProviderSessionInput {
  readonly sessionId: string;
  readonly provider: ProviderKind;
  readonly threadId?: string;
}

export interface DeleteProviderSessionInput {
  readonly sessionId: string;
}

export interface GetProviderSessionInput {
  readonly sessionId: string;
}

export interface ProviderSessionRepositoryShape {
  readonly upsertSession: (
    input: UpsertProviderSessionInput,
  ) => Effect.Effect<void, ProviderSessionRepositoryError>;

  readonly getSession: (
    input: GetProviderSessionInput,
  ) => Effect.Effect<Option.Option<ProviderSessionEntry>, ProviderSessionRepositoryError>;

  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<ProviderSessionEntry>,
    ProviderSessionRepositoryError
  >;

  readonly deleteSession: (
    input: DeleteProviderSessionInput,
  ) => Effect.Effect<void, ProviderSessionRepositoryError>;
}

export class ProviderSessionRepository extends ServiceMap.Service<
  ProviderSessionRepository,
  ProviderSessionRepositoryShape
>()("persistence/ProviderSessionRepository") {}
