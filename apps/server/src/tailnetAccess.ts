import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * TailnetAccess - In-memory record of this process's Tailscale Serve endpoint.
 *
 * The tailnet HTTPS base URL resolves once per boot: to the MagicDNS base URL
 * when Tailscale Serve comes up, or to null when serve is disabled, the
 * tailscale CLI is unavailable, or the node has no MagicDNS name. HTTP handlers
 * read the current value; startup output awaits the resolution so it can
 * prefer the tailnet address in pairing URLs.
 */
export class TailnetAccess extends Context.Service<
  TailnetAccess,
  {
    readonly recordTailnetHttpsBaseUrl: (baseUrl: string | null) => Effect.Effect<void>;
    readonly getTailnetHttpsBaseUrl: Effect.Effect<string | null>;
    readonly awaitTailnetHttpsBaseUrl: Effect.Effect<string | null>;
  }
>()("t3/tailnetAccess") {}

export const make = Effect.gen(function* () {
  const current = yield* Ref.make<string | null>(null);
  const resolved = yield* Deferred.make<string | null>();

  return TailnetAccess.of({
    recordTailnetHttpsBaseUrl: (baseUrl) =>
      Ref.set(current, baseUrl).pipe(
        Effect.andThen(Deferred.succeed(resolved, baseUrl)),
        Effect.asVoid,
      ),
    getTailnetHttpsBaseUrl: Ref.get(current),
    awaitTailnetHttpsBaseUrl: Deferred.await(resolved),
  });
});

export const layer = Layer.effect(TailnetAccess, make);
