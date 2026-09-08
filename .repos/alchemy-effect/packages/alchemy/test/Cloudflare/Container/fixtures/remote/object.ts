import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

/**
 * A sibling resource whose output is threaded into the container's `env`,
 * proving that a pre-built image (no Effect bundling, no `.make()`) receives
 * environment variables that resolve from other resources in the stack.
 */
export const EnvBucket = Cloudflare.R2.Bucket("RemoteContainerEnvBucket", {
  forceDestroy: true,
});

/** Plain-text env value the container is expected to echo back verbatim. */
export const DEMO_PLAIN = "hello-from-env";
/** `Redacted` env value — encrypted in state, plain inside the container. */
export const DEMO_SECRET = "sh-hh-its-a-secret";

export class RemoteContainer extends Cloudflare.Container<RemoteContainer>()(
  "RemoteContainer",
  Effect.gen(function* () {
    const bucket = yield* EnvBucket;
    return {
      image: "mendhak/http-https-echo:latest",
      observability: { logs: { enabled: true } },
      env: {
        // Tells the echo image to include `process.env` in its JSON response.
        ECHO_INCLUDE_ENV_VARS: "1",
        DEMO_PLAIN,
        DEMO_SECRET: Redacted.make(DEMO_SECRET),
        DEMO_BUCKET: bucket.bucketName,
      },
    };
  }),
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
        // The proxy pattern from #1334: forward the incoming request to the
        // container verbatim. In production the incoming web Request carries
        // an https:// URL, which workerd's container ports reject — the
        // runtime must downgrade the scheme on the container hop.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          return yield* fetch(request);
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
