import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SandboxContainer } from "./SandboxContainer.ts";

/**
 * Durable Object that fronts {@link SandboxContainer} — the only way a
 * Worker reaches a Container. `EchoWorker` proxies `GET /sandbox` here.
 */
export default class SandboxDO extends Cloudflare.DurableObject<SandboxDO>()(
  "SandboxDO",
  Effect.gen(function* () {
    const container = yield* SandboxContainer;

    return Effect.gen(function* () {
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: true });
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const url = new URL(request.url, "http://container");
          // Forward the subpath: `/sandbox/host-fetch` → `/host-fetch`.
          const path = url.pathname.replace(/^\/sandbox/, "") || "/";
          yield* start;
          const { fetch } = yield* container.getTcpPort(3000);
          const response = yield* fetch(HttpClientRequest.get(`http://container${path}`));
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            headers: response.headers,
          });
        }),
      };
    });
  }),
) {}
