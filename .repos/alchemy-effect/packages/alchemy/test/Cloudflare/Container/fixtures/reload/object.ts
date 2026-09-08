import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { RELOAD_CONTAINER_PORT, ReloadContainer } from "./container.ts";

/** Durable Object fronting {@link ReloadContainer}; proxies `path` into it. */
export class ReloadContainerObject extends Cloudflare.DurableObject<ReloadContainerObject>()(
  "ReloadContainerObject",
  Effect.gen(function* () {
    const container = yield* ReloadContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(RELOAD_CONTAINER_PORT);

      return {
        read: (path: string) =>
          Effect.gen(function* () {
            const response = yield* fetch(
              HttpClientRequest.get(`http://container${path}`),
            );
            return yield* response.text;
          }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(ReloadContainer, { enableInternet: false }),
    ),
  ),
) {}
