import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export class RemoteContainer extends Cloudflare.Container<RemoteContainer>()(
  "RemoteContainer",
  {
    image: "mendhak/http-https-echo:latest",
    observability: { logs: { enabled: true } },
  },
) {}

/**
 * Durable Object that binds and starts the {@link RemoteContainer} and
 * proxies an HTTP request to the echo server running on port 8080 inside it.
 */
export class RemoteContainerObject extends Cloudflare.DurableObject<RemoteContainerObject>()(
  "RemoteContainerObject",
  Effect.gen(function* () {
    const container = yield* RemoteContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        hello: () =>
          Effect.gen(function* () {
            const response = yield* fetch(
              HttpClientRequest.get("http://container/"),
            );
            return yield* response.text;
          }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(RemoteContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
