import * as net from "node:net";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { vi } from "vitest";
import { listenOnLoopback } from "../internal/listen-on-loopback.ts";

describe("Docker proxy lifetime", () => {
  it.effect("closes its listener when the scope ends", () =>
    Effect.gen(function* () {
      const server = net.createServer();
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(yield* listenOnLoopback(server)).toBeGreaterThan(0);
          expect(server.listening).toBe(true);
        }),
      );
      expect(server.listening).toBe(false);
    }),
  );

  it.live("destroys open connections when the scope ends", () =>
    Effect.gen(function* () {
      const server = net.createServer();
      const socket = yield* Effect.scoped(
        Effect.gen(function* () {
          const port = yield* listenOnLoopback(server);
          return yield* Effect.callback<net.Socket>((resume) => {
            const socket = net.connect(port, "127.0.0.1", () => resume(Effect.succeed(socket)));
            // Closing the scope destroys the server side of this connection;
            // macOS then reports ECONNRESET on the client. Without a listener
            // Node rethrows it as an uncaught exception and fails the run.
            socket.on("error", () => {});
          });
        }),
      );
      yield* Effect.callback<void>((resume) => {
        if (socket.destroyed || socket.readyState === "closed") resume(Effect.void);
        else socket.once("close", () => resume(Effect.void));
      }).pipe(Effect.timeout("5 seconds"));
      expect(server.listening).toBe(false);
    }),
  );

  it.effect("reports listen errors instead of waiting forever", () =>
    Effect.gen(function* () {
      const server = net.createServer();
      const cause = new Error("listen failed");
      vi.spyOn(server, "listen").mockImplementation(() => {
        queueMicrotask(() => server.emit("error", cause));
        return server;
      });
      const result = yield* listenOnLoopback(server).pipe(Effect.scoped, Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.subtag).toBe("DockerProxyListen");
        expect(result.failure.cause).toBe(cause);
      }
      expect(server.listenerCount("error")).toBe(0);
      expect(server.listenerCount("listening")).toBe(0);
    }),
  );
});
