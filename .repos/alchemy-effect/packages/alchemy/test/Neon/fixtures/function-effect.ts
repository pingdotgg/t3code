import {
  upgradeWebSocket,
  waitUntil as nativeWaitUntil,
} from "@neon/functions";
import { Function } from "@/Neon/Function";
import { FunctionRequest } from "@/Neon/FunctionEnvironment";
import { waitUntil } from "@/Neon/waitUntil";
import { upgrade } from "@/Neon/upgrade";
import { Project } from "@/Neon/Project";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Postgres } from "@/SQL/Postgres";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const diagnosticSql = Effect.gen(function* () {
  return yield* Postgres({
    url: Config.Redacted("DATABASE_URL"),
    maxConnections: 1,
  });
});

const recordLifecycle = (id: string, phase: string) =>
  Effect.gen(function* () {
    const sql = yield* diagnosticSql;
    yield* sql`INSERT INTO alchemy_function_lifecycle (id, phase) VALUES (${id}, ${phase}) ON CONFLICT DO NOTHING`;
  }).pipe(Effect.scoped);

const recordNativeLifecycle = (id: string, phase: string) => {
  console.info(JSON.stringify({ nativeLifecycle: { id, phase } }));
  nativeWaitUntil(Effect.runPromise(recordLifecycle(id, phase)));
};

// This handler bypasses makeFunctionBridge entirely.
export const nativeDiagnosticFetch = (request: Request) =>
  Effect.gen(function* () {
    const sql = yield* diagnosticSql;
    yield* sql`CREATE TABLE IF NOT EXISTS alchemy_function_lifecycle (id text, phase text, PRIMARY KEY (id, phase))`;
    const url = yield* Effect.sync(() => new URL(request.url));
    const id = url.searchParams.get("id") ?? "native";
    if (url.pathname === "/diagnostics") {
      const rows =
        yield* sql`SELECT id, phase FROM alchemy_function_lifecycle ORDER BY id, phase`;
      return yield* Effect.sync(() => Response.json(rows));
    }
    yield* recordLifecycle(id, "entered");
    yield* Effect.sync(() =>
      request.signal.addEventListener(
        "abort",
        () => recordNativeLifecycle(id, "abort"),
        { once: true },
      ),
    );
    if (url.pathname === "/websocket") {
      return yield* Effect.sync(() => {
        const { socket, response } = upgradeWebSocket(request);
        socket.addEventListener("open", () =>
          recordNativeLifecycle(id, "open"),
        );
        socket.addEventListener("message", (event) => socket.send(event.data));
        socket.addEventListener(
          "close",
          () => recordNativeLifecycle(id, "close"),
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => recordNativeLifecycle(id, "error"),
          { once: true },
        );
        return response;
      });
    }
    return yield* Effect.sync(() => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          return Effect.runPromise(
            Effect.sleep("100 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  controller.enqueue(
                    new TextEncoder().encode("data: tick\n\n"),
                  );
                }),
              ),
            ),
          );
        },
        cancel() {
          recordNativeLifecycle(id, "cancel");
        },
      });
      return new Response(stream, {
        headers: url.searchParams.has("sse")
          ? {
              "content-type": "text/event-stream",
              "cache-control": "no-cache, no-transform",
            }
          : undefined,
      });
    });
  }).pipe(Effect.scoped, Effect.runPromise);

export default class RuntimeFunction extends Function<RuntimeFunction>()(
  "RuntimeFunction",
  Effect.gen(function* () {
    const project = yield* Project("RuntimeProject", {
      region: "aws-us-east-2",
    });
    return {
      project,
      main: import.meta.url,
      env: { FUNCTION_MESSAGE: "effect" },
    };
  }),
  Effect.gen(function* () {
    const message = yield* Config.String("FUNCTION_MESSAGE").pipe(
      Config.withDefault("effect"),
    );
    const sql = yield* Postgres({
      url: Config.Redacted("DATABASE_URL"),
      maxConnections: 1,
    });
    let active = 0;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://function.test");
        yield* sql`CREATE TABLE IF NOT EXISTS alchemy_function_finalizers (id text PRIMARY KEY)`.pipe(
          Effect.orDie,
        );
        yield* sql`CREATE TABLE IF NOT EXISTS alchemy_function_lifecycle (id text, phase text, PRIMARY KEY (id, phase))`.pipe(
          Effect.orDie,
        );
        if (url.pathname === "/diagnostics") {
          const rows =
            yield* sql`SELECT id, phase FROM alchemy_function_lifecycle ORDER BY id, phase`.pipe(
              Effect.orDie,
            );
          return yield* HttpServerResponse.json(rows);
        }
        if (url.pathname === "/finalized") {
          const rows = yield* sql<{
            id: string;
          }>`SELECT id FROM alchemy_function_finalizers`.pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            finalized: rows.map((row) => row.id),
            active,
          });
        }
        const id = url.searchParams.get("id") ?? "default";
        yield* Effect.sync(() => {
          active++;
        });
        yield* recordLifecycle(id, "entered").pipe(Effect.orDie);
        const report = (phase: string) =>
          Effect.sync(() =>
            console.info(JSON.stringify({ functionFinalizer: { id, phase } })),
          ).pipe(Effect.andThen(recordLifecycle(id, phase)), Effect.orDie);
        yield* Effect.addFinalizer(() =>
          report("started").pipe(
            Effect.andThen(
              sql`INSERT INTO alchemy_function_finalizers (id) VALUES (${id}) ON CONFLICT DO NOTHING`,
            ),
            Effect.tapCause(() => report("failed")),
            Effect.orDie,
            Effect.andThen(
              Effect.sync(() => {
                active--;
              }),
            ),
            Effect.andThen(report("completed")),
          ),
        );
        const nativeRequest = yield* FunctionRequest;
        const onAbort = () => Effect.runFork(report("request-aborted"));
        yield* Effect.sync(() =>
          nativeRequest.signal.addEventListener("abort", onAbort, {
            once: true,
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            nativeRequest.signal.removeEventListener("abort", onAbort),
          ),
        );
        if (url.pathname === "/background") {
          yield* waitUntil(
            Effect.sleep("250 millis").pipe(
              Effect.andThen(
                sql`INSERT INTO alchemy_function_finalizers (id) VALUES ('background-work') ON CONFLICT DO NOTHING`,
              ),
            ),
          );
          return HttpServerResponse.text("scheduled");
        }
        if (url.pathname === "/websocket") {
          const { socket, response } = yield* upgrade();
          yield* Effect.sync(() => {
            socket.addEventListener("message", (event) =>
              socket.send(event.data),
            );
            socket.addEventListener(
              "close",
              () => Effect.runFork(report("socket-closed")),
              { once: true },
            );
          });
          return response;
        }
        if (url.pathname === "/stream-cancel")
          return HttpServerResponse.stream(
            Stream.fromEffectRepeat(
              Effect.sleep("100 millis").pipe(Effect.as("tick")),
            ).pipe(
              Stream.encodeText,
              Stream.ensuring(report("stream-released")),
            ),
            {
              headers: url.searchParams.has("sse")
                ? {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache, no-transform",
                  }
                : undefined,
            },
          );
        if (url.pathname === "/error")
          return yield* Effect.die(
            new Error("intentional effect function failure"),
          );
        if (url.pathname === "/empty")
          return HttpServerResponse.empty({ status: 204 });
        if (url.pathname === "/stream")
          return HttpServerResponse.stream(
            Stream.make("data: first\n\n", "data: second\n\n").pipe(
              Stream.encodeText,
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        if (url.pathname === "/slow") yield* Effect.sleep("200 millis");
        return HttpServerResponse.text(message);
      }),
    };
  }),
) {}
