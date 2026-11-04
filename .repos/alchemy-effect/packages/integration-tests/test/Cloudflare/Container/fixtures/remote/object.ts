import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

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
      vcpu: 1,
      memoryMib: 4096,
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
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: true });
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        hello: () =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* fetch(HttpClientRequest.get("http://container/"));
            return yield* response.text;
          }),
        // The proxy pattern from #1334: forward the incoming request to the
        // container verbatim. In production the incoming web Request carries
        // an https:// URL, which workerd's container ports reject — the
        // runtime must downgrade the scheme on the container hop.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          yield* start;
          return yield* fetch(request);
        }),
      };
    });
  }),
) {}

/**
 * The echo image capped at one instance, so a second Durable Object's start
 * finds no container instance to run on.
 */
export class CappedContainer extends Cloudflare.Container<CappedContainer>()("CappedContainer", {
  image: "mendhak/http-https-echo:latest",
  maxInstances: 1,
}) {}

/**
 * Starts the {@link CappedContainer} and reports how it ends within a short
 * window: the error tag `start` or `monitor` failed with, or `running`.
 */
export class CappedContainerObject extends Cloudflare.DurableObject<CappedContainerObject>()(
  "CappedContainerObject",
  Effect.gen(function* () {
    const container = yield* CappedContainer;

    return Effect.succeed({
      start: Effect.fn("start")(function* () {
        const started = yield* container.start({ enableInternet: true }).pipe(Effect.result);
        if (Result.isFailure(started)) return { phase: "start", tag: started.failure._tag };
        const monitored = yield* container
          .monitor()
          .pipe(Effect.timeoutOption("20 seconds"), Effect.result);
        if (Result.isFailure(monitored))
          return {
            phase: "monitor",
            tag: monitored.failure._tag,
            detail: String(monitored.failure.cause ?? monitored.failure.message),
          };
        return { phase: "monitor", tag: Option.isNone(monitored.success) ? "running" : "exited" };
      }),
    });
  }),
) {}
