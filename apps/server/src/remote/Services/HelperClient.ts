import type { RemoteHostId } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  RemoteHelperHostCapabilities,
  RemoteHelperMethodParams,
  RemoteHelperMethodResults,
  RemoteHostBoundNotification,
} from "../protocol.ts";

export class RemoteHelperError extends Schema.TaggedErrorClass<RemoteHelperError>()(
  "RemoteHelperError",
  {
    message: Schema.String,
    remoteHostId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface RemoteHelperClientShape {
  readonly call: <TMethod extends keyof RemoteHelperMethodParams & string>(
    remoteHostId: RemoteHostId,
    method: TMethod,
    params: RemoteHelperMethodParams[TMethod],
  ) => Effect.Effect<RemoteHelperMethodResults[TMethod], RemoteHelperError>;
  readonly testConnection: (
    remoteHostId: RemoteHostId,
  ) => Effect.Effect<RemoteHelperHostCapabilities, RemoteHelperError>;
  readonly subscribe: (
    listener: (notification: RemoteHostBoundNotification) => void,
  ) => Effect.Effect<() => void>;
}

export class RemoteHelperClient extends ServiceMap.Service<
  RemoteHelperClient,
  RemoteHelperClientShape
>()("t3/remote/Services/HelperClient/RemoteHelperClient") {}
