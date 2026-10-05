import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import * as Service from "../bindings/Service.ts";
import { registerHttpServer } from "../HttpServer.ts";
import { localRuntimeLayer, startTestWorker } from "./helpers/runtime.ts";

layer(localRuntimeLayer, { excludeTestServices: true })(
  "HTTP dev server bindings",
  (it) => {
    it.effect(
      "forwards HTTP and WebSockets, unregisters, and reconnects after restart",
      () =>
        Effect.gen(function* () {
          const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            response.writeHead(201, {
              "set-cookie": ["first=1", "second=2"],
              "x-upstream": "dev",
            });
            response.end(
              JSON.stringify({
                method: request.method,
                url: request.url,
                host: request.headers.host,
                proto: request.headers["x-forwarded-proto"],
                cookie: request.headers.cookie,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          });
          const sockets = new WebSocketServer({ server });
          sockets.on("connection", (socket) =>
            socket.on("message", (message) => socket.send(message.toString())),
          );
          const upstream = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<URL>((resolve) => {
                  server.listen(0, "127.0.0.1", () => {
                    const address = server.address();
                    if (!address || typeof address === "string")
                      throw new Error("Expected TCP address");
                    resolve(new URL(`http://127.0.0.1:${address.port}`));
                  });
                }),
            ),
            () =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    for (const client of sockets.clients) client.terminate();
                    sockets.close();
                    server.closeAllConnections();
                    server.close(() => resolve());
                  }),
              ),
          );
          const gateway = yield* startTestWorker({
            name: "http-server-gateway",
            compatibilityDate: "2026-03-10",
            compatibilityFlags: [],
            bindings: [
              Service.local({
                binding: "WEBSITE",
                scriptName: "http-server-website",
              }),
            ],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: `export default {
          fetch(request, env) {
            const url = new URL(request.url);
            url.host = "website.example";
            url.port = "";
            url.protocol = "https:";
            return env.WEBSITE.fetch(new Request(url, request));
          }
        };`,
              },
            ],
          });
          const checkStatus = (status: number) =>
            Effect.tryPromise(async () => {
              const response = await fetch(gateway.baseUrl, {
                signal: AbortSignal.timeout(3000),
              });
              await response.text();
              expect(response.status).toBe(status);
            }).pipe(
              Effect.retry({
                times: 8,
                schedule: Schedule.spaced("250 millis"),
              }),
            );
          yield* checkStatus(503);
          const parent = yield* Effect.scope;
          const registration = yield* Scope.fork(parent);
          yield* registerHttpServer("http-server-website", upstream).pipe(
            Scope.provide(registration),
          );
          yield* checkStatus(201);
          const response = yield* gateway.fetch("/submit?q=hello%20world", {
            method: "POST",
            body: "request body",
            headers: { cookie: "session=abc" },
          });
          expect(response.status).toBe(201);
          expect(response.headers.get("x-upstream")).toBe("dev");
          expect(response.headers.getSetCookie()).toEqual([
            "first=1",
            "second=2",
          ]);
          expect(yield* Effect.promise(() => response.json())).toEqual({
            method: "POST",
            url: "/submit?q=hello%20world",
            host: "website.example",
            proto: "https",
            cookie: "session=abc",
            body: "request body",
          });
          yield* Effect.tryPromise(
            () =>
              new Promise<void>((resolve, reject) => {
                const url = new URL("/socket", gateway.baseUrl);
                url.protocol = "ws:";
                const socket = new WebSocket(url);
                const timer = setTimeout(() => {
                  socket.terminate();
                  reject(new Error("WebSocket timed out"));
                }, 3000);
                socket.on("error", (error) => {
                  clearTimeout(timer);
                  reject(error);
                });
                socket.on("open", () => socket.send("hello"));
                socket.on("message", (message) => {
                  clearTimeout(timer);
                  socket.close();
                  if (message.toString() === "hello") resolve();
                  else
                    reject(
                      new Error(`Unexpected WebSocket message: ${message}`),
                    );
                });
              }),
          );
          yield* Scope.close(registration, Exit.void);
          yield* checkStatus(503);
          yield* registerHttpServer("http-server-website", upstream);
          yield* checkStatus(201);
        }),
    );
  },
);
