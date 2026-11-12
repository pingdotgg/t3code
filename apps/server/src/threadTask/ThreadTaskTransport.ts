import {
  EnvironmentId,
  type McpGatewayRelayEvent,
  type McpGatewayRelayThreadTaskRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";

export type ThreadTaskRemoteRequest = McpGatewayRelayThreadTaskRequest;

/**
 * Reaches another environment through a connected T3 app. The receiving server
 * authorizes each call by the task's capability, never by the app's session.
 */
export class ThreadTaskTransport extends Context.Service<
  ThreadTaskTransport,
  {
    readonly localEnvironmentId: EnvironmentId;
    /** Fails with a reason when no connected app reaches the environment. */
    readonly call: (
      environmentId: EnvironmentId,
      request: ThreadTaskRemoteRequest,
      /** The modes of the chat that made the call; the app answering applies them there. */
      modeCeiling?: McpGatewayRelayEvent["modeCeiling"],
    ) => Effect.Effect<unknown, string>;
    /** Environments a connected app currently reaches, as far as the network allows. */
    readonly peers: () => ReadonlyArray<EnvironmentId>;
    /** Emits when a path to other environments may have opened. */
    readonly connected: Stream.Stream<void>;
  }
>()("t3/threadTask/ThreadTaskTransport") {}

export const layerFromBroker = Layer.effect(
  ThreadTaskTransport,
  Effect.gen(function* () {
    const broker = yield* McpGatewayBroker;
    const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    return ThreadTaskTransport.of({
      localEnvironmentId: descriptor.environmentId,
      call: Effect.fn("ThreadTaskTransport.call")((environmentId, request, modeCeiling) =>
        broker
          .call("threadTask", [environmentId, request], modeCeiling)
          .pipe(Effect.mapError((error) => error.message)),
      ),
      peers: () =>
        Object.keys(broker.view().grants)
          .filter((id) => id !== descriptor.environmentId)
          .map((id) => EnvironmentId.make(id)),
      connected: broker.hostConnected,
    });
  }),
);
