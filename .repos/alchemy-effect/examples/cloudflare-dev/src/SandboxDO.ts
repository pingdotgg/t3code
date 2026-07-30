import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpServerResponse } from "effect/unstable/http";
import { SandboxContainer } from "./SandboxContainer.ts";

export default class SandboxDO extends Cloudflare.DurableObject<SandboxDO>()(
  "SandboxDO",
  Effect.gen(function* () {
    const container = yield* SandboxContainer;

    return Effect.gen(function* () {
      return {
        fetch: Effect.gen(function* () {
          const { fetch } = yield* container.getTcpPort(3000);
          const response = yield* fetch(
            HttpClientRequest.get("http://container/"),
          );
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            headers: response.headers,
          });
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(SandboxContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
