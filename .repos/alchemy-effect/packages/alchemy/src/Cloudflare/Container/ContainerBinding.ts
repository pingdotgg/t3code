import * as Effect from "effect/Effect";
import { type Rpc } from "../../Rpc.ts";
import {
  fromCloudflareFetcher,
  toCloudflareFetcher,
  type Fetcher,
} from "../Fetcher.ts";
import { DurableObjectNamespace } from "../Workers/DurableObjectNamespace.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { Worker } from "../Workers/Worker.ts";
import type { Container } from "./Container.ts";
import type { ContainerApplication } from "./ContainerApplication.ts";

export const bindContainer = Effect.fnUntraced(function* <Shape, Req = never>(
  containerEff:
    | (ContainerApplication & Rpc<Shape>)
    | Effect.Effect<ContainerApplication & Rpc<Shape>, never, Req>,
) {
  const namespace = yield* DurableObjectNamespace;

  const container =
    "asEffect" in containerEff
      ? yield* containerEff as any as Effect.Effect<
          ContainerApplication & Rpc<Shape>
        >
      : Effect.isEffect(containerEff)
        ? yield* containerEff as unknown as Effect.Effect<
            ContainerApplication & Rpc<Shape>
          >
        : containerEff;

  yield* container.bind`${namespace}`({
    durableObjects: {
      namespaceId: namespace.namespaceId,
    },
  });

  const worker = yield* Worker;
  const className = namespace.name;

  yield* worker.bind`${container.LogicalId}`({
    containers: [{ className }],
  });

  // TODO(sam): register this in the Container Execution Context
  // const _httpEffect = yield* init;
  return Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return {
      running: Effect.sync(() => state.container!.running ?? false),
      destroy: (error?: any) =>
        Effect.promise(() => state.container!.destroy(error)),
      signal: (signo: number) =>
        Effect.sync(() => state.container!.signal(signo)),
      getTcpPort: (port: number) =>
        Effect.sync(() =>
          fromCloudflareFetcher(state.container!.getTcpPort(port)),
        ),
      setInactivityTimeout: (durationMs: number | bigint) =>
        Effect.sync(() => state.container!.setInactivityTimeout(durationMs)),
      interceptOutboundHttp: (addr: string, binding: Fetcher) =>
        toCloudflareFetcher(binding).pipe(
          Effect.map((binding) =>
            state.container!.interceptOutboundHttp(addr, binding),
          ),
        ),
      interceptAllOutboundHttp: (binding: Fetcher) =>
        toCloudflareFetcher(binding).pipe(
          Effect.map((binding) =>
            state.container!.interceptAllOutboundHttp(binding),
          ),
        ),
      monitor: () =>
        Effect.promise(() => state.container?.monitor() ?? Promise.resolve()),
      start: (options?: ContainerStartupOptions) =>
        Effect.sync(() => state.container!.start(options)),
    } satisfies Container as Shape;
  });
});
