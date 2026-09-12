import * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface RelayEdgeStub {
  readonly configureEndpoint: (
    endpointKey: string,
    connectorToken: string,
    connectorLeaseId: string,
  ) => Effect.Effect<void, never, Alchemy.RuntimeContext>;
  readonly revokeEndpoint: (
    endpointKey: string,
    connectorLeaseId?: string,
  ) => Effect.Effect<boolean, never, Alchemy.RuntimeContext>;
}

export class T3RelayEndpointControl extends Context.Service<
  T3RelayEndpointControl,
  {
    readonly configure: (input: {
      readonly endpointKey: string;
      readonly connectorToken: string;
      readonly connectorLeaseId: string;
    }) => Effect.Effect<void>;
    readonly revoke: (input: {
      readonly endpointKey: string;
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
      configure: ({ endpointKey, connectorToken, connectorLeaseId }) =>
        edge
          .configureEndpoint(endpointKey, connectorToken, connectorLeaseId)
          .pipe(Effect.provideService(Alchemy.RuntimeContext, runtimeContext)),
      revoke: ({ endpointKey, connectorLeaseId }) =>
        edge
          .revokeEndpoint(endpointKey, connectorLeaseId)
          .pipe(Effect.provideService(Alchemy.RuntimeContext, runtimeContext)),
    }),
  );
