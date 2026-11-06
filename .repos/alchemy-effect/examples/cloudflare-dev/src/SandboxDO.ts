import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpServerResponse } from "effect/http";
import { SandboxContainer } from "./SandboxContainer.ts";

export default class SandboxDO extends Cloudflare.DurableObject<SandboxDO>()(
  "SandboxDO",
  Effect.gen(function* () {
    const container = yield* SandboxContainer;

    return Effect.gen(function* () {
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: true });
      return {
        fetch: Effect.gen(function* () {
          yield* start;
          const { fetch } = yield* container.getTcpPort(3000);
          const response = yield* fetch(HttpClientRequest.get("http://container/"));
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            headers: response.headers,
          });
        }),
      };
    });
  }),
) {}
