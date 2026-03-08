import { RemoteHostRecord, RemoteHostId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const GetRemoteHostInput = Schema.Struct({
  remoteHostId: RemoteHostId,
});
export type GetRemoteHostInput = typeof GetRemoteHostInput.Type;

export const DeleteRemoteHostInput = Schema.Struct({
  remoteHostId: RemoteHostId,
});
export type DeleteRemoteHostInput = typeof DeleteRemoteHostInput.Type;

export interface RemoteHostRepositoryShape {
  readonly upsert: (row: RemoteHostRecord) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetRemoteHostInput,
  ) => Effect.Effect<Option.Option<RemoteHostRecord>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<RemoteHostRecord>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: DeleteRemoteHostInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class RemoteHostRepository extends ServiceMap.Service<
  RemoteHostRepository,
  RemoteHostRepositoryShape
>()("t3/persistence/Services/RemoteHosts/RemoteHostRepository") {}
