import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { IsolatedContainer } from "./container.ts";

/** Durable Object backing one {@link IsolatedContainer} instance. */
export class IsolatedObject extends Cloudflare.DurableObject<IsolatedObject>()(
  "IsolatedProjectObject",
  Effect.gen(function* () {
    const container = yield* IsolatedContainer;

    return Effect.gen(function* () {
      return {
        // RPC into the container (forces start + proves it's up).
        ping: () => container.ping(),
        // HTTP over the container's TCP port.
        hello: () =>
          Effect.gen(function* () {
            const { fetch } = yield* container.getTcpPort(3000);
            const response = yield* fetch(
              HttpClientRequest.get("http://container/"),
            );
            return yield* response.text;
          }).pipe(Effect.orDie),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(IsolatedContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
