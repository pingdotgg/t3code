import * as Fly from "@/Fly";
import { HttpServer, NodeHttpServer } from "@/Http";
import { ServerHost } from "@/Server/Process";
import * as Redis from "@/Redis";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  Cache,
  WorkerSite,
  scripts,
  services,
  type Job,
} from "./bluegreen-worker-shared.ts";

export class Worker extends Fly.Service<Worker>()("Worker") {}
export interface WorkerOptions {
  version: string;
  timeout: "10 seconds" | "30 seconds" | "60 seconds";
  signal: "SIGTERM" | "SIGINT";
  runOnly?: boolean;
  mode?: string;
  afterSignalMs?: number;
  workers?: number;
}
export const workerLayer = (options: WorkerOptions) =>
  Worker.make(
    {
      app: WorkerSite,
      main: import.meta.url,
      region: "iad",
      port: 3000,
      guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
      env: {
        VERSION: options.version,
        MODE: options.mode ?? "drain",
        AFTER_SIGNAL_MS: String(options.afterSignalMs ?? 1000),
        WORKERS: String(options.workers ?? 1),
        RUN_ONLY: options.runOnly ? "1" : "0",
      },
      deploy: { strategy: "bluegreen", healthTimeout: "45 seconds" },
      shutdown: { signal: options.signal, timeout: options.timeout },
      services: options.runOnly ? [] : services,
      checks: options.runOnly
        ? {
            ready: {
              type: "http",
              port: 3000,
              path: "/health",
              interval: "2s",
              timeout: "1s",
            },
          }
        : undefined,
    },
    Effect.gen(function* () {
      yield* Fly.ReadWriteRedis(Cache);
      const cache = yield* Cache;
      const boundUrl = yield* cache.url;
      const stopping = yield* Deferred.make<void>();
      const { count, runOnly } = globalThis.__ALCHEMY_RUNTIME__
        ? yield* Effect.all({
            count: Config.Number("WORKERS"),
            runOnly: Config.String("RUN_ONLY").pipe(
              Effect.map((value) => value === "1"),
            ),
          }).pipe(
            // These controls are plain Machine env, not packed runtime bindings.
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv(),
            ),
            Effect.orDie,
          )
        : { count: options.workers ?? 1, runOnly: options.runOnly ?? false };
      const ready = new Set<string>();
      let sharedOpen = true;
      const url = Effect.gen(function* () {
        const value = yield* boundUrl;
        if (!value) return yield* Effect.die(new Error("Redis URL missing"));
        return Redacted.value(value);
      });
      const identify = Effect.gen(function* () {
        return {
          machine: yield* Config.String("FLY_MACHINE_ID"),
          version: yield* Config.String("VERSION"),
        };
      }).pipe(Effect.orDie);
      const connect = url.pipe(
        Effect.flatMap(Redis.connect),
        Effect.timeout("5 seconds"),
        Effect.orDie,
      );
      const event = (
        client: Redis.Connection,
        name: string,
        fields: Record<string, unknown> = {},
      ) =>
        identify.pipe(
          Effect.flatMap((identity) =>
            client.send("EVAL", [
              scripts.event,
              0,
              JSON.stringify({ ...identity, event: name, ...fields }),
            ]),
          ),
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
      if (globalThis.__ALCHEMY_RUNTIME__) {
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const client = yield* connect;
            yield* event(client, "shared-closed");
            sharedOpen = false;
          }).pipe(Effect.scoped),
        );
      }
      const runWorker = (name: string) =>
        Effect.gen(function* () {
          const client = yield* connect;
          const identity = yield* identify;
          const mode =
            name === "a"
              ? yield* Config.String("MODE").pipe(Effect.orDie)
              : "drain";
          const delay = yield* Config.Number("AFTER_SIGNAL_MS").pipe(
            Effect.orDie,
          );
          const call = (operation: keyof typeof scripts, args: string[]) =>
            client
              .send("EVAL", [scripts[operation], 0, ...args])
              .pipe(Effect.timeout("5 seconds"), Effect.orDie);
          yield* Effect.addFinalizer(() =>
            event(client, "client-released", { worker: name }),
          );
          const workScope = yield* Scope.make();
          yield* Effect.addFinalizer((exit) =>
            Scope.close(workScope, exit).pipe(
              Effect.andThen(event(client, "work-closed", { worker: name })),
            ),
          );
          const pollScope = yield* Scope.make();
          yield* Effect.addFinalizer((exit) => Scope.close(pollScope, exit));
          const jobs: Fiber.Fiber<void, never>[] = [];
          let accepting = true;
          const poll = Effect.gen(function* () {
            if (!accepting) return;
            if (name === "a")
              yield* call("tick", [identity.machine, identity.version]);
            const response = yield* call("claim", [
              identity.machine,
              identity.version,
            ]);
            if (typeof response !== "string") return;
            const job = JSON.parse(response) as Job;
            const task = Effect.gen(function* () {
              let finished = false;
              yield* Effect.addFinalizer(() =>
                finished
                  ? Effect.void
                  : call("checkpoint", [
                      job.id,
                      job.job,
                      identity.machine,
                    ]).pipe(Effect.asVoid),
              );
              if (!job.checkpoint && job.kind !== "quick") {
                yield* Deferred.await(stopping);
                if (job.kind === "checkpoint" || mode === "job-hang")
                  yield* Effect.never;
                yield* Effect.sleep(delay);
              } else yield* Effect.sleep("100 millis");
              if (!sharedOpen)
                return yield* Effect.die(
                  new Error("shared dependency closed before job"),
                );
              yield* call("finish", [job.id, job.job, identity.machine]).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    finished = true;
                  }),
                ),
                Effect.uninterruptible,
              );
            }).pipe(
              Effect.scoped,
              Effect.interruptible,
              Effect.forkIn(workScope),
            );
            jobs.push(yield* task);
          }).pipe(Effect.uninterruptible);
          const poller = yield* poll.pipe(
            Effect.andThen(Effect.sleep("250 millis")),
            Effect.forever,
            Effect.forkIn(pollScope),
          );
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* event(client, "stop-started", { worker: name });
              yield* Deferred.succeed(stopping, undefined);
              if (mode === "stop-hang") yield* Effect.never;
              if (mode === "stop-delay") yield* Effect.sleep("1 second");
              accepting = false;
              yield* Fiber.interrupt(poller);
              if (mode === "stop-fail") {
                yield* event(client, "stop-failed", { worker: name });
                yield* Scope.close(workScope, yield* Effect.exit(Effect.void));
                return yield* Effect.die(new Error("application stop failure"));
              }
              yield* event(client, "stopped", { worker: name });
              if (mode === "checkpoint")
                yield* Scope.close(workScope, yield* Effect.exit(Effect.void));
              yield* Effect.forEach(jobs, Fiber.await, {
                concurrency: "unbounded",
              });
              yield* event(client, "drained", { worker: name });
            }),
          );
          yield* event(client, "worker-ready", { worker: name });
          ready.add(name);
          yield* Effect.never;
        }).pipe(Effect.scoped);
      const fetch = Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url === "/health") {
          return HttpServerResponse.text(
            ready.size === count ? "ready" : "starting",
            {
              status: ready.size === count ? 200 : 503,
            },
          );
        }
        const client = yield* connect;
        const identity = yield* identify;
        if (request.url === "/")
          return yield* HttpServerResponse.json(identity);
        yield* event(client, "request-started");
        yield* Effect.addFinalizer(() => event(client, "request-finalized"));
        const delay = yield* Config.Number("AFTER_SIGNAL_MS").pipe(
          Effect.orDie,
        );
        const afterStop = Deferred.await(stopping).pipe(
          Effect.andThen(Effect.sleep(delay)),
          Effect.andThen(
            Effect.sync(() => {
              if (!sharedOpen)
                throw new Error("shared dependency closed before response");
            }),
          ),
          Effect.andThen(event(client, "response-finished")),
        );
        if (request.url === "/stream")
          return HttpServerResponse.stream(
            Stream.make("first\n".repeat(32768)).pipe(
              Stream.concat(
                Stream.fromEffect(
                  afterStop.pipe(Effect.as("last\n".repeat(32768))),
                ),
              ),
              Stream.mapEffect((chunk) =>
                Effect.sync(() => new TextEncoder().encode(chunk)),
              ),
            ),
          );
        yield* afterStop;
        return yield* HttpServerResponse.json(identity);
      });
      const host = yield* ServerHost;
      if (count > 1) yield* host.run(runWorker("b"));
      if (runOnly) {
        yield* host.run(
          Effect.gen(function* () {
            const server = yield* HttpServer;
            yield* server.serve(fetch);
            yield* Effect.never;
          }).pipe(
            Effect.provide(NodeHttpServer({ hostname: "::" })),
            Effect.scoped,
          ),
        );
      }
      const run = runWorker("a");
      return runOnly ? { run } : { run, fetch };
    }).pipe(Effect.provide(Fly.ReadWriteRedisHttp)),
  );

export default workerLayer({
  version: "default",
  timeout: "30 seconds",
  signal: "SIGTERM",
});
