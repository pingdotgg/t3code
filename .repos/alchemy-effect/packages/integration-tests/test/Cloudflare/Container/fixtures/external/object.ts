import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export class ExternalContainer extends Cloudflare.Container<ExternalContainer>()(
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
 * The same nginx server built from inline `dockerfile.content` instead of a
 * context directory, so the image build has no user-supplied build context.
 */
export class InlineDockerfileContainer extends Cloudflare.Container<InlineDockerfileContainer>()(
  "InlineDockerfileContainer",
  {
    dockerfile: {
      content: [
        "FROM nginxinc/nginx-unprivileged:alpine",
        "USER root",
        "RUN rm -f /var/log/nginx/access.log /var/log/nginx/error.log \\",
        "  && touch /var/log/nginx/access.log /var/log/nginx/error.log \\",
        "  && chown nginx:nginx /var/log/nginx/access.log /var/log/nginx/error.log \\",
        "  && echo 'hello from inline dockerfile container' > /usr/share/nginx/html/index.html",
        "USER nginx",
        "EXPOSE 8080",
        "",
      ].join("\n"),
    },
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
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: true });
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        hello: Effect.fn("hello")(function* () {
          yield* start;
          const response = yield* fetch(HttpClientRequest.get("http://container/"));
          return yield* response.text;
        }),
      };
    });
  }),
) {}

/** Durable Object that binds and proxies to the {@link InlineDockerfileContainer}. */
export class InlineDockerfileContainerObject extends Cloudflare.DurableObject<InlineDockerfileContainerObject>()(
  "InlineDockerfileContainerObject",
  Effect.gen(function* () {
    const container = yield* InlineDockerfileContainer;

    return Effect.gen(function* () {
      const start = container.start({ enableInternet: true });
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        hello: Effect.fn("hello")(function* () {
          yield* start;
          const response = yield* fetch(HttpClientRequest.get("http://container/"));
          return yield* response.text;
        }),
      };
    });
  }),
) {}
