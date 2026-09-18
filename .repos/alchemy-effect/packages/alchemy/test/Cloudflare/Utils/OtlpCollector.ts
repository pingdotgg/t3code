import * as Effect from "effect/Effect";
import { createServer, type Server } from "node:http";

export interface OtlpCollector {
  readonly server: Server;
  /** Base URL (`http://127.0.0.1:<port>`); append the OTLP signal path. */
  readonly url: string;
  /** Responses fully written to the client. */
  readonly completedRequests: { value: number };
}

/**
 * Starts a local OTLP endpoint that accepts every export and counts the
 * responses fully written to the client. `responseDelay` (ms) holds each
 * response so tests can observe workerd cancellation vs. `waitUntil`
 * delivery. The Node server is a test adapter only.
 */
export const startOtlpCollector = (options: { responseDelay?: number } = {}) =>
  Effect.acquireRelease(
    Effect.callback<OtlpCollector, Error>((resume) => {
      const completedRequests = { value: 0 };
      const server = createServer((request, response) => {
        request.resume();
        request.once("end", () => {
          setTimeout(() => {
            response.once("finish", () => {
              completedRequests.value += 1;
            });
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"partialSuccess":{}}');
          }, options.responseDelay ?? 0);
        });
      });
      const onError = (error: Error) => resume(Effect.fail(error));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(
            Effect.fail(new Error("OTLP test collector address unavailable")),
          );
          return;
        }
        resume(
          Effect.succeed({
            server,
            completedRequests,
            url: `http://127.0.0.1:${address.port}`,
          }),
        );
      });
      return Effect.sync(() => server.close());
    }),
    ({ server }) =>
      Effect.callback<void, Error>((resume) => {
        server.close((error) =>
          resume(error === undefined ? Effect.void : Effect.fail(error)),
        );
      }).pipe(Effect.orDie),
  );
