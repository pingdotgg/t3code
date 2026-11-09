import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as EffectHttp from "effect/http/HttpEffect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

class Finalizers extends Cloudflare.DurableObject<Finalizers>()(
  "Finalizers",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.succeed({
      record: (entry: string) => state.storage.put(entry, true),
      has: (entry: string) => state.storage.get<boolean>(entry),
      fetch: Effect.gen(function* () {
        const [response] = yield* Cloudflare.upgrade();
        return response;
      }),
      webSocketMessage: (socket: Cloudflare.WebSocket, message: string | Uint8Array) =>
        socket.send(message),
      webSocketClose: (socket: Cloudflare.WebSocket, code: number, reason: string) =>
        socket.close(code, reason),
    });
  }),
) {}

export default class RawResponseWorker extends Cloudflare.Worker<RawResponseWorker>()(
  "RawResponseWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const finalizers = yield* Finalizers;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.url, "https://worker.test"));
        const path = url.pathname;
        const journal = finalizers.getByName("requests");
        if (path === "/ready") {
          yield* journal.has("ready");
          return HttpServerResponse.text("raw-response:ready");
        }
        if (path === "/finalized") {
          return HttpServerResponse.text(
            String((yield* journal.has(url.searchParams.get("entry")!)) ?? false),
          );
        }
        if (path === "/websocket") return yield* journal.fetch(request);

        yield* Effect.addFinalizer(() =>
          journal.record(`${request.method}:${path}`).pipe(Effect.orDie),
        );

        if (path === "/status" || path === "/stream") {
          yield* EffectHttp.appendPreResponseHandler((_, response) =>
            Effect.succeed(
              response.pipe(
                HttpServerResponse.setHeader("x-observed-status", String(response.status)),
                HttpServerResponse.setHeader(
                  "x-observed-native",
                  response.headers["x-native"] ?? "missing",
                ),
                HttpServerResponse.setStatus(418),
                HttpServerResponse.setHeader("x-native", "effect"),
                HttpServerResponse.removeHeader("x-remove"),
              ),
            ),
          );
        } else if (path === "/cookie") {
          yield* EffectHttp.appendPreResponseHandler((_, response) =>
            Effect.succeed(
              HttpServerResponse.setCookieUnsafe(response, "session", "abc", {
                path: "/",
              }),
            ),
          );
        } else if (
          path === "/no-content" ||
          path === "/reset-content" ||
          path === "/not-modified"
        ) {
          yield* EffectHttp.appendPreResponseHandler((_, response) =>
            Effect.succeed(
              HttpServerResponse.setStatus(
                response,
                path === "/no-content" ? 204 : path === "/reset-content" ? 205 : 304,
              ),
            ),
          );
        }

        const native = yield* Effect.sync(() => {
          const body =
            path === "/stream"
              ? new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("raw-response:streamed"));
                    controller.close();
                  },
                })
              : "raw-response:body";
          return new Response(body, {
            status: 202,
            headers: [
              ["x-native", "native"],
              ["x-remove", "native"],
              ["set-cookie", "a=1; Path=/"],
              ["set-cookie", "b=2; Path=/"],
            ],
          });
        });
        const response = HttpServerResponse.fromWeb(native);
        if (path === "/constructed-header") {
          return HttpServerResponse.setHeader(response, "x-native", "constructed");
        }
        if (path === "/explicit-status") {
          return HttpServerResponse.setStatus(response, 201);
        }
        return response;
      }),
    };
  }),
) {}
