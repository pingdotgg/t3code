import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { RELOAD_CONTAINER_PORT, ReloadContainer } from "./container.ts";

/** Durable Object fronting {@link ReloadContainer}; proxies `path` into it. */
export class ReloadContainerObject extends Cloudflare.DurableObject<ReloadContainerObject>()(
  "ReloadContainerObject",
  Effect.gen(function* () {
    const container = yield* ReloadContainer;

    return Effect.gen(function* () {
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: false });
      const { fetch } = yield* container.getTcpPort(RELOAD_CONTAINER_PORT);

      return {
        read: (path: string) =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* fetch(HttpClientRequest.get(`http://container${path}`));
            return yield* response.text;
          }),
      };
    });
  }),
) {}
