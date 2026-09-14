import * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { RelayEndpointAddress } from "./routing.ts";

interface RelayEdgeStub {
  readonly configureEndpoint: (
    address: RelayEndpointAddress,
    connectorToken: string,
    connectorLeaseId: string,
  ) => Effect.Effect<void, never, Alchemy.RuntimeContext>;
  readonly revokeEndpoint: (
    address: RelayEndpointAddress,
    connectorLeaseId?: string,
  ) => Effect.Effect<boolean, never, Alchemy.RuntimeContext>;
}

export class T3RelayEndpointControl extends Context.Service<
  T3RelayEndpointControl,
  {
    readonly configure: (input: {
      readonly address: RelayEndpointAddress;
      readonly connectorToken: string;
      readonly connectorLeaseId: string;
    }) => Effect.Effect<void>;
    readonly revoke: (input: {
      readonly address: RelayEndpointAddress;
      readonly connectorLeaseId?: string;
    }) => Effect.Effect<boolean>;
  }
>()("t3code-relay/transport/T3RelayEndpointControl") {}

export const layerWorkerBinding = (
  edge: RelayEdgeStub,
  runtimeContext: Alchemy.BaseRuntimeContext,
) =>
  Layer.succeed(
    T3RelayEndpointControl,
    T3RelayEndpointControl.of({
      configure: ({ address, connectorToken, connectorLeaseId }) =>
        edge
          .configureEndpoint(address, connectorToken, connectorLeaseId)
          .pipe(Effect.provideService(Alchemy.RuntimeContext, runtimeContext)),
      revoke: ({ address, connectorLeaseId }) =>
        edge
          .revokeEndpoint(address, connectorLeaseId)
          .pipe(Effect.provideService(Alchemy.RuntimeContext, runtimeContext)),
    }),
  );
