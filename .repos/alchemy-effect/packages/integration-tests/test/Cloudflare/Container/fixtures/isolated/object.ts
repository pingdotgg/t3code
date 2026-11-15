import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { IsolatedContainer } from "./container.ts";

/** Durable Object backing one {@link IsolatedContainer} instance. */
export class IsolatedObject extends Cloudflare.DurableObject<IsolatedObject>()(
  "IsolatedProjectObject",
  Effect.gen(function* () {
    const container = yield* IsolatedContainer;

    return Effect.gen(function* () {
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: true });
      return {
        // RPC into the container (starts it + proves it's up).
        ping: () => start.pipe(Effect.andThen(container.ping())),
        // HTTP over the container's TCP port.
        hello: () =>
          Effect.gen(function* () {
            yield* start;
            const { fetch } = yield* container.getTcpPort(3000);
            const response = yield* fetch(HttpClientRequest.get("http://container/"));
            return yield* response.text;
          }).pipe(Effect.orDie),
      };
    });
  }),
) {}
