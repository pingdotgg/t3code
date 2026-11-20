import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { HttpClient } from "effect/http";

export interface RelayClientTracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface RelayClientTracingResource {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly runtime: string;
  readonly serviceInstanceId: string;
  readonly client: string;
  readonly component?: string;
  readonly attributes?: Readonly<Record<string, string>> | undefined;
}

export class RelayClientTracer extends Context.Reference(
  "@t3tools/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

class LocalTracer extends Context.Reference("@t3tools/shared/relayTracing/LocalTracer", {
  defaultValue: () => Option.none<Tracer.Tracer>(),
}) {}

/** Export only T3 Connect spans; wrap local work with {@link withLocalTracing}. */
export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) =>
          Tracer.Tracer.pipe(
            Effect.flatMap((local) =>
              effect.pipe(
                Effect.provideService(Tracer.Tracer, tracer),
                Effect.provideService(LocalTracer, Option.some(local)),
              ),
            ),
          ),
      }),
    ),
  );

/** Keep local work in the local trace without exporting machine details through relay spans. */
export const withLocalTracing = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  LocalTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (local) => effect.pipe(Effect.provideService(Tracer.Tracer, local)),
      }),
    ),
  );

// PseudoCode exports no traces to any outside service, whatever config a build carries.
export function layer(
  _config: RelayClientTracingConfig | null,
  _resource: RelayClientTracingResource,
  _options?: { readonly isEnabled?: () => boolean },
): Layer.Layer<never, never, HttpClient.HttpClient> {
  return Layer.succeed(RelayClientTracer, Option.none());
}
