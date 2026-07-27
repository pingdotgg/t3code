import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import WebSocket from "ws";
import WebSocketTestFunctionLive, { WebSocketTestFunction } from "./ws-handler";

const { test } = Test.make({ providers: AWS.providers() });

class WebSocketFailure extends Data.TaggedError("WebSocketFailure")<{
  readonly reason: string;
}> {}

class FixtureNotConsistent extends Data.TaggedError("FixtureNotConsistent") {}

/**
 * Connect a wss client, send one frame, and resolve with the first frame
 * received back. Encapsulates the socket in `Effect.callback` so fiber
 * interruption (the outer `Effect.timeout`) closes the socket.
 *
 * An `{"message": "Internal server error"}` frame is API Gateway reporting
 * that the route's Lambda invocation failed — right after a fresh deploy
 * that is IAM/binding propagation, so it fails as a retryable
 * `WebSocketFailure` rather than resolving.
 */
const wsSendAndReceive = (url: string, message: string) =>
  Effect.callback<string, WebSocketFailure>((resume, signal) => {
    const socket = new WebSocket(url);
    let settled = false;
    const settle = (effect: Effect.Effect<string, WebSocketFailure>) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resume(effect);
    };
    signal.addEventListener("abort", () =>
      settle(Effect.fail(new WebSocketFailure({ reason: "interrupted" }))),
    );
    socket.on("open", () => socket.send(message));
    socket.on("message", (data) => {
      const frame = String(data);
      if (frame.includes('"Internal server error"')) {
        settle(
          Effect.fail(
            new WebSocketFailure({
              reason: `route invocation failed: ${frame}`,
            }),
          ),
        );
      } else {
        settle(Effect.succeed(frame));
      }
    });
    socket.on("error", (error) =>
      settle(Effect.fail(new WebSocketFailure({ reason: String(error) }))),
    );
    socket.on("close", (code) =>
      settle(
        Effect.fail(
          new WebSocketFailure({ reason: `closed before echo (${code})` }),
        ),
      ),
    );
  });

test.provider(
  "WebSocket API echoes via ManageConnections",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WebSocketTestFunction.pipe(
            Effect.provide(WebSocketTestFunctionLive),
          );
        }),
      );
      expect(fn.functionUrl).toBeTruthy();

      // Discover the wss:// URL through the fixture's function URL.
      // Two eventual-consistency windows to ride out: function-URL cold
      // start (non-200s) and Lambda env-config propagation — an instance
      // initialized before the binding env update serves `{}` until it is
      // recycled, so poll until `wsUrl` is actually present.
      const info = yield* HttpClient.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`fixture returned ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          typeof (body as { wsUrl?: string }).wsUrl === "string"
            ? Effect.succeed(body as { wsUrl: string; callbackUrl: string })
            : Effect.fail(new FixtureNotConsistent()),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential("500 millis").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(
                  Duration.isGreaterThan(duration, Duration.seconds(3))
                    ? Duration.seconds(3)
                    : duration,
                ),
              ),
            ),
            Schedule.recurs(30),
          ]),
        }),
      );
      const { wsUrl, callbackUrl } = info;
      expect(wsUrl).toMatch(/^wss:\/\//);
      expect(callbackUrl).toMatch(/^https:\/\//);

      // Connect, send, and expect the Lambda to push the echo back over
      // the socket. The first connections retry through route/permission/
      // IAM propagation (failed invocations surface as retryable
      // "Internal server error" frames).
      const echoed = yield* wsSendAndReceive(wsUrl, "hello-websocket").pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(
                  Duration.isGreaterThan(duration, Duration.seconds(5))
                    ? Duration.seconds(5)
                    : duration,
                ),
              ),
            ),
            Schedule.recurs(10),
          ]),
        }),
      );
      expect(echoed).toBe("echo:hello-websocket");

      // A second frame on a fresh connection round-trips too (no
      // propagation retry needed once the first succeeded).
      const second = yield* wsSendAndReceive(wsUrl, "again").pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential("1 second"),
            Schedule.recurs(3),
          ]),
        }),
      );
      expect(second).toBe("echo:again");

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
