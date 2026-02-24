import {
  IsoDateTime,
  ProviderSessionId,
  ProviderSessionRuntimeStatus,
  ProviderThreadId,
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

export interface ProviderSessionRuntimeRepositoryShape {
  readonly upsert: (
    runtime: ProviderSessionRuntime,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  readonly getBySessionId: (
    input: GetProviderSessionRuntimeInput,
  ) => Effect.Effect<Option.Option<ProviderSessionRuntime>, ProviderSessionRuntimeRepositoryError>;

  readonly list: () => Effect.Effect<
    ReadonlyArray<ProviderSessionRuntime>,
    ProviderSessionRuntimeRepositoryError
  >;

  readonly deleteBySessionId: (
    input: DeleteProviderSessionRuntimeInput,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;
}

export class ProviderSessionRuntimeRepository extends ServiceMap.Service<
  ProviderSessionRuntimeRepository,
  ProviderSessionRuntimeRepositoryShape
>()("persistence/ProviderSessionRuntimeRepository") {}
