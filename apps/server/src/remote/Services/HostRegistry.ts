import type {
  RemoteHostId,
  RemoteHostRecord,
  RemoteHostUpsertInput,
} from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface RemoteHostConnectionStateUpdate {
  readonly remoteHostId: RemoteHostId;
  readonly helperVersion?: string | null;
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly message?: string | null;
}

export interface RemoteHostRegistryShape {
  readonly list: () => Effect.Effect<ReadonlyArray<RemoteHostRecord>, ProjectionRepositoryError>;
  readonly getById: (
    remoteHostId: RemoteHostId,
  ) => Effect.Effect<Option.Option<RemoteHostRecord>, ProjectionRepositoryError>;
  readonly upsert: (
    input: RemoteHostUpsertInput,
  ) => Effect.Effect<RemoteHostRecord, ProjectionRepositoryError>;
  readonly remove: (remoteHostId: RemoteHostId) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly updateConnectionState: (
    input: RemoteHostConnectionStateUpdate,
  ) => Effect.Effect<RemoteHostRecord, ProjectionRepositoryError>;
}

export class RemoteHostRegistry extends ServiceMap.Service<
  RemoteHostRegistry,
  RemoteHostRegistryShape
>()("t3/remote/Services/HostRegistry/RemoteHostRegistry") {}
