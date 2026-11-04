import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** Only the owning object's `interceptOutboundHttp` answers this host. */
export const INTERCEPT_HOST = "intercept.internal";

class InterceptContainer extends Cloudflare.Container<InterceptContainer>()("InterceptContainer", {
  // Template string, not `path.join(import.meta.dirname, …)`: this module is
  // bundled into the Worker and `import.meta.dirname` is undefined there.
  context: `${import.meta.dirname}/context`,
}) {}

/**
 * Durable Object that owns an {@link InterceptContainer} through
 * `yield* InterceptContainer` and routes the container's outbound HTTP back to itself:
 * the Fetcher it registers is a stub for its own id, so intercepted requests
 * arrive at its `fetch`.
 */
export class InterceptContainerObject extends Cloudflare.DurableObject<InterceptContainerObject>()(
  "InterceptContainerObject",
  Effect.gen(function* () {
    const container = yield* InterceptContainer;
    const state = yield* Cloudflare.DurableObjectState;
    const env = yield* Cloudflare.WorkerEnvironment;

    return Effect.gen(function* () {
      const self = Cloudflare.fromCloudflareFetcher(env.InterceptContainerObject.get(state.id));
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: false });
      const { fetch } = yield* container.getTcpPort(8080);

      const probe = (url: string) =>
        Effect.gen(function* () {
          const response = yield* fetch(
            HttpClientRequest.get(`http://container/probe?url=${encodeURIComponent(url)}`),
          );
          return yield* response.text;
        });

      return {
        // The container's intercepted requests.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          return HttpServerResponse.text(`intercepted ${request.headers.host}${request.url}`);
        }),
        probeHost: () =>
          start.pipe(
            Effect.andThen(container.interceptOutboundHttp(INTERCEPT_HOST, self)),
            Effect.andThen(probe(`http://${INTERCEPT_HOST}/hello`)),
          ),
        probeAll: () =>
          start.pipe(
            Effect.andThen(container.interceptAllOutboundHttp(self)),
            Effect.andThen(probe("http://any.example/hello")),
          ),
      };
    });
  }),
) {}
