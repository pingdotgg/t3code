import * as Cloudflare from "@/Cloudflare";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

class ExternalContainer extends Cloudflare.Container<ExternalContainer>()(
  "ExternalContainer",
  {
    // Use a template string rather than `path.join(import.meta.dirname, …)`:
    // this module is bundled into the Worker (it defines the DO), and
    // `import.meta.dirname` is `undefined` in the Worker runtime — calling
    // `path.join(undefined, …)` there throws a ScriptStartupError at module
    // load. `context` is only consumed at build time, so a plain string is
    // sufficient and never evaluates `path.join` at runtime.
    context: `${import.meta.dirname}/context`,
    observability: { logs: { enabled: true } },
  },
) {}

/**
 * Durable Object that binds and starts the {@link ExternalContainer} and
 * proxies an HTTP request to the nginx server running on port 8080 inside it.
 */
export class ExternalContainerObject extends Cloudflare.DurableObject<ExternalContainerObject>()(
  "ExternalContainerObject",
  Effect.gen(function* () {
    const container = yield* ExternalContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        hello: Effect.fn("hello")(function* () {
          const response = yield* fetch(
            HttpClientRequest.get("http://container/"),
          );
          return yield* response.text;
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Containers.layer(ExternalContainer, {
          enableInternet: true,
        }),
      ),
    ),
  ),
) {}
