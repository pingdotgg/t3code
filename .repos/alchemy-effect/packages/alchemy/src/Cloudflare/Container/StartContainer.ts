import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type Fetcher } from "../Fetcher.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import {
  type Container,
  ContainerError,
  type ContainerStartupOptions,
} from "./Container.ts";
/**
 * Runs the Container in a Durable Object and monitors it, providing a durable fetch and RPC interface to it.
 */
export const start = Effect.fnUntraced(function* <
  Shape extends Container,
  Req = never,
>(
  containerEff: Effect.Effect<Shape, never, Req | DurableObjectState>,
  options?: ContainerStartupOptions,
) {
  const container = yield* containerEff;

  const ensureRunning = Effect.gen(function* () {
    if (yield* container.running) return;
    yield* Effect.logInfo("Container not running, starting...");
    yield* container.start(options);
    yield* Effect.logInfo("Container started, launching monitor");
    yield* Effect.forkDetach(
      container.monitor().pipe(
        Effect.flatMap(() => Effect.logInfo("Container monitor exited")),
        Effect.catchTag("ContainerError", (error) =>
          Effect.logError(`Container monitor error: ${error.message}`),
        ),
      ),
    );
  });

  yield* ensureRunning;

  const startupBackoff = Schedule.exponential(100, 1.5).pipe(
    Schedule.modifyDelay((_, delay) =>
      Effect.succeed(Duration.max(delay, Duration.seconds(2))),
    ),
  );

  const getTcpPort = (portNumber: number) =>
    Effect.succeed({
      fetch: ((
        request:
          | HttpClientRequest.HttpClientRequest
          | HttpServerRequest.HttpServerRequest,
      ) =>
        ensureRunning.pipe(
          Effect.andThen(() => container.getTcpPort(portNumber)),
          Effect.andThen((port: Fetcher) => port.fetch(request as any)),
          Effect.catchDefect((defect: unknown) =>
            Effect.fail(
              new ContainerError({
                message: `Container not ready on port ${portNumber}: ${defect}`,
              }),
            ),
          ),
          Effect.tapError((err) =>
            Effect.logDebug(`Container fetch error (will retry): ${err}`),
          ),
          Effect.retry({ schedule: startupBackoff }),
        )) as {
        (
          request: HttpClientRequest.HttpClientRequest,
        ): Effect.Effect<HttpClientResponse.HttpClientResponse>;
        (
          request: HttpServerRequest.HttpServerRequest,
        ): Effect.Effect<HttpServerResponse.HttpServerResponse>;
      },
    });

  return {
    ...container,
    getTcpPort,
    fetch: getTcpPort(3000),
  };
});
