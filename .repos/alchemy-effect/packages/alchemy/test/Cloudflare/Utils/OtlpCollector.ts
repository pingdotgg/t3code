import * as Effect from "effect/Effect";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

export interface OtlpCollector {
  readonly server: Server;
  /** Base URL (`http://127.0.0.1:<port>`); append the OTLP signal path. */
  readonly url: string;
  /** Responses fully written to the client. */
  readonly completedRequests: { value: number };
  /** Received batches, including exports whose client disconnected. */
  readonly requests: Array<{
    body: string;
    receivedAt: number;
    responseStartedAt?: number;
    closedAt?: number;
    completed: boolean;
    aborted: boolean;
  }>;
  /** Re-arm the response gate for subsequent matching batches. */
  readonly holdResponses: () => void;
  /** Acknowledge held batches and leave the gate open until re-armed. */
  readonly releaseResponses: () => void;
}

/**
 * Starts a local OTLP endpoint that records exports and completed responses.
 * Matching `holdResponse` batches wait for explicit release, so tests can
 * assert response/export ordering without timer races. The Node server is
 * a test adapter only.
 */
export const startOtlpCollector = (
  options: {
    holdResponse?: (body: string) => boolean;
  } = {},
) =>
  Effect.acquireRelease(
    Effect.callback<OtlpCollector, Error>((resume) => {
      const completedRequests = { value: 0 };
      const requests: OtlpCollector["requests"] = [];
      const pending = new Set<() => void>();
      let held = true;
      const holdResponses = () => {
        held = true;
      };
      const releaseResponses = () => {
        held = false;
        for (const send of pending) send();
        pending.clear();
      };
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.once("end", () => {
          const batch: OtlpCollector["requests"][number] = {
            body,
            receivedAt: Date.now(),
            completed: false,
            aborted: false,
          };
          requests.push(batch);
          const send = () => {
            batch.responseStartedAt = Date.now();
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"partialSuccess":{}}');
          };
          response.once("finish", () => {
            batch.completed = true;
            completedRequests.value += 1;
          });
          response.once("close", () => {
            batch.closedAt = Date.now();
            batch.aborted = !batch.completed;
            pending.delete(send);
          });
          if (held && options.holdResponse?.(body)) {
            pending.add(send);
          } else {
            send();
          }
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
            requests,
            holdResponses,
            releaseResponses,
            url: `http://127.0.0.1:${address.port}`,
          }),
        );
      });
      return Effect.sync(() => server.close());
    }),
    ({ server, releaseResponses }) =>
      Effect.callback<void, Error>((resume) => {
        releaseResponses();
        server.close((error) =>
          resume(error === undefined ? Effect.void : Effect.fail(error)),
        );
      }).pipe(Effect.orDie),
  );

/** Node's native HTTP close events expose cancellations that Bun's adapter omits. */
export const startDelayedOtlpCollector = () =>
  Effect.acquireRelease(
    Effect.callback<
      Pick<OtlpCollector, "url" | "requests" | "completedRequests"> & {
        stop: () => void;
      },
      Error
    >((resume) => {
      const requests: OtlpCollector["requests"] = [];
      const completedRequests = { value: 0 };
      const child = spawn(
        "node",
        [
          "-e",
          `
        const { createServer } = require("node:http");
        const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
        let nextId = 0;
        const server = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => { body += chunk; });
          request.once("end", () => {
            const id = nextId++;
            let completed = false;
            emit({ type: "received", id, body, at: Date.now() });
            const send = () => {
              emit({ type: "responding", id, at: Date.now() });
              response.writeHead(200, { "content-type": "application/json" });
              response.end('{"partialSuccess":{}}');
            };
            const delayed = body.includes('"name":"otel-event-flush.rpc"');
            const timer = delayed ? setTimeout(send, 4000) : undefined;
            response.once("finish", () => {
              completed = true;
              emit({ type: "finished", id, at: Date.now() });
            });
            response.once("close", () => {
              clearTimeout(timer);
              emit({ type: "closed", id, at: Date.now(), aborted: !completed });
            });
            if (!delayed) send();
          });
        });
        server.listen(0, "127.0.0.1", () => emit({ type: "ready", port: server.address().port }));
      `,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const stop = () => {
        child.kill();
      };
      child.once("error", (error) => resume(Effect.fail(error)));
      child.stderr.on("data", (data) => console.error(String(data)));
      let pending = "";
      child.stdout.on("data", (data) => {
        pending += String(data);
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const message = JSON.parse(pending.slice(0, newline)) as
            | { type: "ready"; port: number }
            | { type: "received"; id: number; body: string; at: number }
            | { type: "responding" | "finished"; id: number; at: number }
            | { type: "closed"; id: number; at: number; aborted: boolean };
          pending = pending.slice(newline + 1);
          if (message.type === "ready") {
            resume(
              Effect.succeed({
                url: `http://127.0.0.1:${message.port}`,
                requests,
                completedRequests,
                stop,
              }),
            );
          } else if (message.type === "received") {
            requests[message.id] = {
              body: message.body,
              receivedAt: message.at,
              completed: false,
              aborted: false,
            };
          } else {
            const batch = requests[message.id]!;
            if (message.type === "responding")
              batch.responseStartedAt = message.at;
            else if (message.type === "finished") {
              batch.completed = true;
              completedRequests.value += 1;
            } else if (message.type === "closed") {
              batch.closedAt = message.at;
              batch.aborted = message.aborted;
            }
          }
        }
      });
      return Effect.sync(stop);
    }).pipe(Effect.timeout("5 seconds")),
    ({ stop }) => Effect.sync(stop),
  );
