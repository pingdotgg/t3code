import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Local-dev twin of `object.ts` with its own logical ids so
 * `LocalContainer.test.ts` never shares a container application, Durable
 * Object namespace, or worker with the live `Container.test.ts` deployment
 * when the two files run concurrently.
 */
export class LocalRemoteContainer extends Cloudflare.Container<LocalRemoteContainer>()(
  "LocalRemoteContainer",
  {
    image: "mendhak/http-https-echo:latest",
    observability: { logs: { enabled: true } },
  },
) {}

/**
 * Durable Object that binds and starts the {@link LocalRemoteContainer} and
 * proxies an HTTP request to the echo server running on port 8080 inside it.
 */
export class LocalRemoteContainerObject extends Cloudflare.DurableObject<LocalRemoteContainerObject>()(
  "LocalRemoteContainerObject",
  Effect.gen(function* () {
    const container = yield* LocalRemoteContainer;

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
      Cloudflare.Containers.layer(LocalRemoteContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
