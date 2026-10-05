import { HttpServer, NodeHttpServer } from "alchemy/Http";
import { bootstrap } from "alchemy/Runtime/Bootstrap/Fly";
import { runProcess } from "alchemy/Runtime/Bootstrap/Process";
import { createContainerRuntimeContext } from "alchemy/Server/Process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

Effect.runSync(
  Effect.sync(() => {
    if (process.env.RECORD_SHUTDOWN_TIMING !== "1") return;
    let started: number | undefined;
    const onSignal = () => {
      started ??= performance.now();
    };
    process.prependOnceListener("SIGTERM", onSignal);
    process.prependOnceListener("SIGINT", onSignal);
    process.once("exit", () => {
      if (started !== undefined) {
        console.error(`shutdown elapsed ms: ${performance.now() - started}`);
      }
    });
  }),
);

const event = (message: string) => Effect.sync(() => console.log(message));
let dependencyOpen = true;
const useDependency = Effect.sync(() => {
  if (!dependencyOpen) throw new Error("dependency already closed");
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  if (request.url === "/health") return HttpServerResponse.text("ok");
  yield* Effect.addFinalizer(() =>
    useDependency.pipe(Effect.andThen(event("request dependency released"))),
  );
  yield* Effect.addFinalizer(() =>
    useDependency.pipe(
      Effect.andThen(event("request finalized")),
      Effect.andThen(
        process.env.FAIL_REQUEST_FINALIZER === "1"
          ? Effect.sleep("100 millis").pipe(
              Effect.andThen(Effect.die(new Error("request cleanup defect"))),
            )
          : Effect.void,
      ),
    ),
  );
  yield* event("request started");
  if (request.url === "/handler-error") {
    return yield* Effect.die(new Error("ordinary handler defect"));
  }
  if (request.url === "/hang") return yield* Effect.never;
  if (request.url === "/stream-large") {
    return HttpServerResponse.stream(
      Stream.range(0, 15).pipe(
        Stream.mapEffect((index) =>
          Effect.sleep("60 millis").pipe(
            Effect.andThen(useDependency),
            Effect.andThen(
              event(index === 15 ? "chunk last" : `chunk ${index}`),
            ),
            Effect.andThen(
              Effect.sync(() =>
                new TextEncoder().encode(
                  String(index).padStart(2, "0").repeat(8192),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (request.url === "/stream" || request.url === "/stream-hang") {
    const body = Stream.fromArray(["first\n", "second\n", "last\n"]).pipe(
      Stream.mapEffect((chunk) =>
        Effect.sleep("300 millis").pipe(
          Effect.andThen(useDependency),
          Effect.andThen(event(`chunk ${chunk.trim()}`)),
          Effect.andThen(Effect.sync(() => new TextEncoder().encode(chunk))),
        ),
      ),
    );
    return HttpServerResponse.stream(
      request.url === "/stream-hang"
        ? body.pipe(Stream.concat(Stream.fromEffect(Effect.never)))
        : body,
    );
  }
  yield* Effect.sleep("900 millis");
  yield* useDependency;
  yield* event("response ready");
  return HttpServerResponse.text("completed");
});

class StopFailed extends Data.TaggedError("StopFailed") {}

const worker = (name: string, mode: string) =>
  Effect.gen(function* () {
    let clientOpen = true;
    yield* Effect.addFinalizer(() =>
      useDependency.pipe(
        Effect.andThen(
          Effect.sync(() => {
            clientOpen = false;
          }),
        ),
        Effect.andThen(event(`${name} client released`)),
      ),
    );
    const workScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) =>
      Scope.close(workScope, exit).pipe(
        Effect.andThen(event(`${name} work scope closed`)),
      ),
    );
    const pollScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(pollScope, exit));
    const jobs: Fiber.Fiber<void, never>[] = [];
    let accepting = true;
    let claims = 0;
    const claim = Effect.gen(function* () {
      if (!accepting) return;
      const id = ++claims;
      yield* event(`${name} claim ${id}`);
      const job = Effect.gen(function* () {
        yield* Effect.addFinalizer(() => event(`${name} job ${id} finalized`));
        yield* mode === "job-hang" ? Effect.never : Effect.sleep("900 millis");
        yield* useDependency;
        yield* Effect.sync(() => {
          if (!clientOpen) throw new Error("client already closed");
        });
        yield* event(`${name} job ${id} completed`);
      }).pipe(Effect.scoped, Effect.forkIn(workScope));
      jobs.push(yield* job);
    });
    if (mode !== "stop-delay-empty") yield* claim;
    const poller = yield* Effect.sleep("150 millis").pipe(
      Effect.andThen(claim),
      Effect.forever,
      Effect.forkIn(pollScope),
    );
    const stop = Effect.gen(function* () {
      yield* event(`${name} stop started`);
      if (mode === "stop-hang") yield* Effect.never;
      if (mode === "stop-delay" || mode === "stop-delay-empty") {
        yield* Effect.sleep("700 millis");
      }
      if (mode === "stop-fail") return yield* Effect.fail(new StopFailed());
      accepting = false;
      yield* Fiber.interrupt(poller);
      yield* event(`${name} stopped ${claims}`);
    });
    yield* Effect.addFinalizer(() =>
      stop.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* event(`${name} drain started`);
            yield* Effect.forEach(jobs, Fiber.join, {
              concurrency: "unbounded",
            });
            yield* useDependency;
            yield* event(`${name} drained`);
          }),
        ),
        Effect.catchTag("StopFailed", (error) =>
          Effect.gen(function* () {
            accepting = false;
            yield* Fiber.interrupt(poller);
            yield* event(`${name} checkpoint`);
            yield* Scope.close(workScope, Exit.void);
            return yield* Effect.die(error);
          }),
        ),
      ),
    );
    yield* event(`${name} ready`);
    const requestedExit = name === "worker1" ? process.env.RUN_EXIT : undefined;
    if (mode === "normal" || requestedExit === "normal") return;
    if (mode === "error-delay") yield* Effect.sleep("600 millis");
    if (
      mode === "error" ||
      mode === "error-delay" ||
      requestedExit === "error"
    ) {
      return yield* Effect.die(new Error("worker failed"));
    }
    yield* Effect.never;
  });

const host = createContainerRuntimeContext("Fly.Service")("fixture");
const httpProgram = Effect.gen(function* () {
  const server = yield* HttpServer;
  yield* server.serve(handler);
  yield* event("http ready");
  yield* Effect.never;
});

const entrypoint = Effect.gen(function* () {
  yield* Effect.addFinalizer(() =>
    event("instance finalizing").pipe(
      Effect.andThen(
        process.env.HANG_FINALIZER === "1"
          ? Effect.never
          : Effect.sleep("40 millis"),
      ),
      Effect.andThen(
        Effect.sync(() => {
          dependencyOpen = false;
        }),
      ),
      Effect.andThen(event("instance finalized")),
      Effect.andThen(
        process.env.FAIL_FINALIZER === "1"
          ? Effect.die(new Error("dependency finalizer failed"))
          : Effect.void,
      ),
    ),
  );
  if (process.env.WORKERS) {
    const first = worker("worker1", process.env.WORKER_MODE ?? "drain");
    yield* host.run(
      process.env.NESTED_WORKER === "1" ? Effect.scoped(first) : first,
    );
    if (process.env.WORKERS === "2")
      yield* host.run(worker("worker2", "drain"));
  }
  if (process.env.RUN_ONLY !== "1") yield* host.run(httpProgram);
  return { RuntimeContext: host };
});

if (process.env.UNMANAGED_HOST === "1") {
  await runProcess(
    "Unmanaged service",
    httpProgram.pipe(Effect.provide(NodeHttpServer()), Effect.scoped),
  );
} else {
  await bootstrap(entrypoint);
}
