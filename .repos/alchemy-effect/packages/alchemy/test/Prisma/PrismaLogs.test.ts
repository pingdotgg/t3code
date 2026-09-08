import type { PrismaManagementClient } from "@/Prisma/Client";
import {
  parseDeploymentLogRecord,
  tailDeploymentLogs,
} from "@/Prisma/PrismaLogs";
import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { WebSocketServer } from "ws";

describe("Prisma deployment logs", () => {
  it.effect("decodes compute log records into Alchemy log lines", () =>
    Effect.gen(function* () {
      const timestamp = new Date("2026-01-01T00:00:00.000Z");
      const record = yield* parseDeploymentLogRecord(
        JSON.stringify({
          type: "log",
          text: "server started",
          byteStart: 0,
          byteEnd: 15,
        }),
        timestamp,
      );

      expect(record).toMatchObject({
        _tag: "log",
        line: { timestamp, message: "server started" },
        raw: { byteStart: 0, byteEnd: 15 },
      });
    }),
  );

  it.effect("decodes terminal records", () =>
    Effect.gen(function* () {
      const record = yield* parseDeploymentLogRecord(
        JSON.stringify({
          type: "terminal",
          kind: "end",
          code: "segment_time_limit",
          message: "segment ended",
          retryable: true,
          cursor: "42",
        }),
        new Date("2026-01-01T00:00:00.000Z"),
      );

      expect(record).toEqual({
        _tag: "terminal",
        raw: {
          type: "terminal",
          kind: "end",
          code: "segment_time_limit",
          message: "segment ended",
          retryable: true,
          cursor: "42",
        },
      });
    }),
  );

  it.effect("fails malformed records", () =>
    Effect.gen(function* () {
      const secret = "postgres://admin:do-not-retain@db.example.test/main";
      const error = yield* parseDeploymentLogRecord(
        JSON.stringify({ type: "wat", payload: secret }),
        new Date("2026-01-01T00:00:00.000Z"),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("type: unknown");
      expect(String(error)).not.toContain(secret);
      expect(String(error.cause)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }),
  );

  it.effect("rejects non-integer deployment log byte offsets", () =>
    parseDeploymentLogRecord(
      JSON.stringify({
        type: "log",
        text: "partial",
        byteStart: 0.5,
        byteEnd: 7,
      }),
      new Date("2026-01-01T00:00:00.000Z"),
    ).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain("type: log");
      }),
    ),
  );

  it.effect("streams log lines from Prisma's WebSocket endpoint", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        let authorization: string | undefined;

        server.on("connection", (socket, request) => {
          authorization = request.headers.authorization;
          socket.send(
            JSON.stringify({
              type: "log",
              text: "first",
              byteStart: 0,
              byteEnd: 5,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "log",
              text: "second",
              byteStart: 6,
              byteEnd: 12,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "terminal",
              kind: "end",
              code: "vm_stopped",
              message: "done",
              retryable: false,
              cursor: null,
            }),
          );
        });

        const client = {
          getDeploymentLogsRequest: (
            deploymentId: string,
            query: { tail?: number } | undefined,
          ) =>
            Effect.succeed({
              url: `${url}/v1/deployments/${deploymentId}/logs?tail=${query?.tail}`,
              headers: {
                Authorization: Redacted.make("Bearer test-token"),
              },
            }),
        } as unknown as PrismaManagementClient;

        const lines = yield* tailDeploymentLogs(client, "deployment-1", {
          tail: 2,
        }).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual(["first", "second"]);
        expect(authorization).toBe("Bearer test-token");
      }),
    ),
  );

  it.effect("rejects deployment log frames larger than 1 MiB", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        const marker = "oversized-secret-marker";
        server.on("connection", (socket) => {
          socket.send(marker.repeat(60_000));
        });

        const error = yield* tailDeploymentLogs(
          logsClient(url),
          "deployment-1",
        ).pipe(Stream.runCollect, Effect.flip);

        expect(String(error)).toContain("exceeds the 1048576-byte frame limit");
        expect(String(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
      }),
    ),
  );

  it.effect(
    "fails instead of buffering unbounded logs for a slow consumer",
    () =>
      withWebSocketServer((server) =>
        Effect.gen(function* () {
          const url = yield* listenUrl(server);
          server.on("connection", (socket) => {
            let byteOffset = 0;
            for (let index = 0; index < 1_000; index++) {
              const text = `line-${index}`;
              socket.send(logRecord(text, byteOffset));
              byteOffset += text.length;
            }
            socket.send(
              terminalRecord({
                kind: "end",
                code: "vm_stopped",
                retryable: false,
                cursor: null,
              }),
            );
          });

          const error = yield* tailDeploymentLogs(
            logsClient(url),
            "deployment-1",
          ).pipe(
            Stream.runForEach(() => Effect.yieldNow),
            Effect.flip,
          );

          expect(String(error)).toContain("consumer fell behind");
          expect(String(error)).toContain("64-record safety buffer");
        }),
      ),
  );

  it.effect("reconnects from retryable terminal cursors exactly once", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        const queries: Array<{ cursor?: string }> = [];
        let connections = 0;

        server.on("connection", (socket, request) => {
          connections += 1;
          const cursor = new URL(request.url ?? "/", url).searchParams.get(
            "cursor",
          );
          queries.push(cursor === null ? {} : { cursor });
          if (connections === 1) {
            socket.send(logRecord("first"));
            const terminal = terminalRecord({
              kind: "end",
              code: "segment_time_limit",
              retryable: true,
              cursor: "cursor-1",
            });
            socket.send(terminal);
            // A duplicate frame from the old segment must not open another
            // reconnect in parallel.
            socket.send(terminal);
            return;
          }
          socket.send(logRecord("second", 5));
          socket.send(
            terminalRecord({
              kind: "end",
              code: "vm_stopped",
              retryable: false,
              cursor: null,
            }),
          );
        });

        const lines = yield* tailDeploymentLogs(
          logsClient(url),
          "deployment-1",
        ).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual(["first", "second"]);
        expect(connections).toBe(2);
        expect(queries).toEqual([{}, { cursor: "cursor-1" }]);
      }),
    ),
  );

  it.effect("fails non-retryable terminal errors", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        server.on("connection", (socket) => {
          socket.send(
            terminalRecord({
              kind: "error",
              code: "permission_denied",
              message: "logs are unavailable",
              retryable: false,
              cursor: null,
            }),
          );
        });

        const error = yield* tailDeploymentLogs(
          logsClient(url),
          "deployment-1",
        ).pipe(Stream.runCollect, Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("permission_denied");
        expect(String(error)).toContain("logs are unavailable");
      }),
    ),
  );

  it.effect("reconnects a transient close from the latest confirmed byte", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        let connections = 0;
        server.on("connection", (socket) => {
          connections += 1;
          if (connections === 1) {
            socket.send(logRecord("partial"));
            socket.close(1000, "unexpected end");
            return;
          }
          socket.send(
            terminalRecord({
              kind: "end",
              code: "vm_stopped",
              retryable: false,
              cursor: null,
            }),
          );
        });

        const lines = yield* tailDeploymentLogs(
          logsClient(url),
          "deployment-1",
        ).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual(["partial"]);
        expect(connections).toBe(2);
      }),
    ),
  );

  it.effect(
    "reconnects a retryable null-cursor terminal from the last byte",
    () =>
      withWebSocketServer((server) =>
        Effect.gen(function* () {
          const url = yield* listenUrl(server);
          const cursors: Array<string | null> = [];
          server.on("connection", (socket, request) => {
            cursors.push(
              new URL(request.url ?? "/", url).searchParams.get("cursor"),
            );
            if (cursors.length === 1) {
              socket.send(logRecord("first"));
              socket.send(
                terminalRecord({
                  kind: "error",
                  code: "upstream_error",
                  retryable: true,
                  cursor: null,
                }),
              );
              return;
            }
            socket.send(
              terminalRecord({
                kind: "end",
                code: "vm_stopped",
                retryable: false,
                cursor: null,
              }),
            );
          });

          const lines = yield* tailDeploymentLogs(
            logsClient(url),
            "deployment-1",
          ).pipe(Stream.runCollect);

          expect(lines.map((line) => line.message)).toEqual(["first"]);
          expect(cursors).toEqual([null, "5"]);
        }),
      ),
  );

  it.effect(
    "fails retry loops that alternate cursors without byte progress",
    () =>
      withWebSocketServer((server) =>
        Effect.gen(function* () {
          const url = yield* listenUrl(server);
          let connections = 0;
          server.on("connection", (socket) => {
            connections += 1;
            socket.send(
              terminalRecord({
                kind: "end",
                code: "segment_time_limit",
                retryable: true,
                cursor: connections % 2 === 0 ? "cursor-2" : "cursor-1",
              }),
            );
          });

          const error = yield* tailDeploymentLogs(
            logsClient(url),
            "deployment-1",
          ).pipe(Stream.runCollect, Effect.flip);

          expect(connections).toBe(4);
          expect(String(error)).toContain("made no progress after 3 reconnect");
        }),
      ),
  );

  it.effect("times out a WebSocket that never completes its handshake", () =>
    withSilentTcpServer((url, connected) =>
      Effect.gen(function* () {
        const client = logsClient(url);
        const fiber = yield* tailDeploymentLogs(client, "deployment-1").pipe(
          Stream.runCollect,
          Effect.flip,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* connected;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("11 seconds");
        const error = yield* Fiber.join(fiber);

        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain(
          "WebSocket handshake timed out after 10 seconds",
        );
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("interrupts cleanly while a WebSocket is still connecting", () =>
    withSilentTcpServer((url, connected) =>
      Effect.gen(function* () {
        const fiber = yield* tailDeploymentLogs(
          logsClient(url),
          "deployment-1",
        ).pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));

        yield* connected;
        yield* Fiber.interrupt(fiber);
        const exit = fiber.pollUnsafe();

        expect(exit?._tag).toBe("Failure");
      }),
    ),
  );
});

const logsClient = (baseUrl: string) =>
  ({
    getDeploymentLogsRequest: (
      deploymentId: string,
      query: { cursor?: string } | undefined,
    ) => {
      const url = new URL(`/v1/deployments/${deploymentId}/logs`, baseUrl);
      if (query?.cursor !== undefined) {
        url.searchParams.set("cursor", query.cursor);
      }
      return Effect.succeed({
        url: url.toString(),
        headers: { Authorization: Redacted.make("Bearer test-token") },
      });
    },
  }) as unknown as PrismaManagementClient;

const logRecord = (text: string, byteStart = 0) =>
  JSON.stringify({
    type: "log",
    text,
    byteStart,
    byteEnd: byteStart + text.length,
  });

const terminalRecord = (input: {
  kind: "end" | "error";
  code: string;
  message?: string;
  retryable: boolean;
  cursor: string | null;
}) =>
  JSON.stringify({
    type: "terminal",
    message: "segment ended",
    ...input,
  });

const withWebSocketServer = <A, E, R>(
  f: (server: WebSocketServer) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
    f,
    (server) =>
      Effect.callback<void>((resume) => {
        // This release runs as an uninterruptible finalizer, and bun's ws
        // shim does not reliably fire the `server.close` callback once a
        // connection was closed server-side — terminate stragglers and
        // bound the wait so a shim quirk can't hang the test process.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          if (timer !== undefined) clearTimeout(timer);
          resume(Effect.void);
        };
        for (const client of server.clients) client.terminate();
        timer = setTimeout(done, 1_000);
        server.close(done);
      }).pipe(Effect.ignore),
  );

const listenUrl = (server: WebSocketServer) =>
  Effect.callback<string, Error>((resume) => {
    const complete = () => {
      cleanup();
      const address = server.address();
      if (address && typeof address === "object") {
        resume(Effect.succeed(`ws://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("WebSocket server has no TCP address")));
      }
    };
    const fail = (cause: unknown) => {
      cleanup();
      resume(
        Effect.fail(cause instanceof Error ? cause : new Error(String(cause))),
      );
    };
    const cleanup = () => {
      server.off("listening", complete);
      server.off("error", fail);
    };

    if (server.address()) {
      complete();
      return;
    }

    server.once("listening", complete);
    server.once("error", fail);
    return Effect.sync(cleanup);
  });

interface SilentTcpServer {
  server: Server;
  sockets: Set<Socket>;
  url: string;
}

const withSilentTcpServer = <A, E, R>(
  f: (url: string, connected: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const connected = yield* Deferred.make<void>();
    return yield* Effect.acquireUseRelease(
      Effect.callback<SilentTcpServer, Error>((resume) => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          Deferred.doneUnsafe(connected, Effect.void);
          socket.on("data", () => {
            // Intentionally never complete the HTTP upgrade handshake.
          });
          socket.on("error", () => {});
          socket.on("close", () => sockets.delete(socket));
        });
        const onError = (cause: Error) => {
          cleanup();
          resume(Effect.fail(cause));
        };
        const onListening = () => {
          cleanup();
          const address = server.address();
          if (!address || typeof address === "string") {
            resume(Effect.fail(new Error("TCP server has no address")));
            return;
          }
          resume(
            Effect.succeed({
              server,
              sockets,
              url: `ws://127.0.0.1:${address.port}`,
            }),
          );
        };
        const cleanup = () => {
          server.off("error", onError);
          server.off("listening", onListening);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
        return Effect.sync(() => {
          cleanup();
          for (const socket of sockets) socket.destroy();
          server.close();
        });
      }),
      ({ url }) => f(url, Deferred.await(connected)),
      ({ server, sockets }) =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resume(Effect.void));
        }).pipe(Effect.ignore),
    );
  });
