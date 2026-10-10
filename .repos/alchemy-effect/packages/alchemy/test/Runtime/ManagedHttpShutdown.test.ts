import { findAvailablePort, nodeLoaderArgs } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import { createHash } from "node:crypto";

const services = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

const spawnFixture = (
  env: Record<string, string | undefined> = {},
  waitForReady = true,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fixture = yield* path.fromFileUrl(
      new URL("./fixtures/managed-http-shutdown.ts", import.meta.url),
    );
    const port = yield* findAvailablePort();
    const args = yield* Effect.sync(() => nodeLoaderArgs(fixture));
    const handle = yield* ChildProcess.make("node", [...args, fixture], {
      env: {
        ALCHEMY_STACK_NAME: "managed-http-shutdown",
        ALCHEMY_STAGE: "test",
        ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "3000",
        PORT: String(port),
        ...env,
      },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGKILL",
    });
    const output: string[] = [];
    const ready = yield* Deferred.make<void>();
    yield* Stream.merge(handle.stdout, handle.stderr).pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          output.push(chunk);
          const marker = env.RUN_ONLY === "1" ? "worker1 ready" : "http ready";
          if (output.join("").includes(marker))
            Deferred.doneUnsafe(ready, Effect.void);
        }),
      ),
      Effect.forkScoped,
    );
    if (waitForReady) {
      yield* Deferred.await(ready).pipe(
        Effect.timeout("15 seconds"),
        Effect.tapError(() => Effect.logError(output.join(""))),
      );
    }
    const client = yield* HttpClient.HttpClient;
    return {
      handle,
      output: () => output.join(""),
      signal: (signal: "SIGTERM" | "SIGINT") =>
        Effect.sync(() => process.kill(handle.pid, signal)),
      get: (route: string) =>
        client.get(`http://127.0.0.1:${port}${route}`, {
          headers: { connection: "close" },
        }),
    };
  });

const waitForOutput = (fixture: { output: () => string }, text: string) =>
  Effect.sync(fixture.output).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("200 millis"),
      until: (output) => output.includes(text),
      times: 10,
    }),
    Effect.tap((output) => Effect.sync(() => expect(output).toContain(text))),
  );

// Measure the child's shutdown budget separately from signal delivery and reaping.
const shutdownElapsed = (fixture: { output: () => string }) =>
  waitForOutput(fixture, "shutdown elapsed ms:").pipe(
    Effect.map((output) => {
      const match = /shutdown elapsed ms: ([\d.]+)/.exec(output);
      expect(match).not.toBeNull();
      return Number(match![1]);
    }),
  );

const refusesNewRequests = (
  fixture: Effect.Success<ReturnType<typeof spawnFixture>>,
) =>
  fixture.get("/health").pipe(
    Effect.timeout("200 millis"),
    Effect.result,
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: Result.isFailure,
      times: 8,
    }),
    Effect.tap((result) =>
      Effect.sync(() => expect(Result.isFailure(result)).toBe(true)),
    ),
  );

const assertFinalizerOrder = (output: string, finished: string) => {
  expect(output.indexOf(finished)).toBeGreaterThanOrEqual(0);
  expect(output.indexOf("request finalized")).toBeGreaterThan(
    output.indexOf(finished),
  );
  expect(output.indexOf("instance finalizing")).toBeGreaterThan(
    output.indexOf("request finalized"),
  );
  expect(output).toContain("instance finalized");
};

const before = (output: string, first: string, second: string) => {
  expect(output.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(output.indexOf(second)).toBeGreaterThan(output.indexOf(first));
};

const assertWorkerOrder = (output: string, name: string) => {
  before(output, `${name} stop started`, `${name} stopped`);
  before(output, `${name} stopped`, `${name} drain started`);
  before(output, `${name} drain started`, `${name} drained`);
  before(output, `${name} drained`, `${name} work scope closed`);
  before(output, `${name} work scope closed`, `${name} client released`);
  const afterStop = output.slice(output.indexOf(`${name} stopped`));
  expect(afterStop).not.toContain(`${name} claim`);
  expect(output).not.toContain("already closed");
};

describe.sequential("managed Fly HTTP shutdown", { tags: ["local"] }, () => {
  it.live(
    "R03 SIGTERM stops acceptance and drains a slow response before instance finalizers",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture();
        const response = yield* fixture.get("/slow").pipe(
          Effect.flatMap((response) => response.text),
          Effect.forkChild,
        );
        yield* waitForOutput(fixture, "request started");
        yield* fixture.signal("SIGTERM");
        yield* refusesNewRequests(fixture);
        yield* fixture.signal("SIGINT");
        expect(yield* Fiber.join(response)).toBe("completed");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        assertFinalizerOrder(fixture.output(), "response ready");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R04 SIGINT drains the entire streaming body before closing scopes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture();
        const first = yield* Deferred.make<void>();
        const chunks: string[] = [];
        const response = yield* fixture.get("/stream").pipe(
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.decodeText,
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  chunks.push(chunk);
                  Deferred.doneUnsafe(first, Effect.void);
                }),
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        yield* fixture.signal("SIGINT");
        yield* refusesNewRequests(fixture);
        yield* Fiber.join(response);
        expect(chunks.join("")).toBe("first\nsecond\nlast\n");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        assertFinalizerOrder(fixture.output(), "chunk last");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R05 closes a stalled stream at the drain deadline and finishes instance cleanup",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "2000",
          RECORD_SHUTDOWN_TIMING: "1",
        });
        const first = yield* Deferred.make<void>();
        const response = yield* fixture.get("/stream-hang").pipe(
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.runForEach(() => Deferred.succeed(first, undefined)),
            ),
          ),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        yield* fixture.signal("SIGTERM");
        expect(
          yield* fixture.handle.exitCode.pipe(Effect.timeout("5 seconds")),
        ).toBe(1);
        expect(Result.isFailure(yield* Fiber.join(response))).toBe(true);
        const elapsed = yield* shutdownElapsed(fixture);
        expect(elapsed).toBeGreaterThanOrEqual(1500);
        expect(elapsed).toBeLessThan(2000);
        yield* waitForOutput(fixture, "instance finalized");
        assertFinalizerOrder(fixture.output(), "chunk last");
        expect(fixture.output()).toContain("drain deadline exceeded");
        expect(fixture.output()).not.toContain("shutdown deadline exceeded");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R05 bounds a stuck request and instance finalizer below the Fly stop deadline",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "2000",
          HANG_FINALIZER: "1",
          RECORD_SHUTDOWN_TIMING: "1",
        });
        const response = yield* fixture
          .get("/hang")
          .pipe(Effect.result, Effect.forkChild);
        yield* waitForOutput(fixture, "request started");
        yield* fixture.signal("SIGTERM");
        yield* refusesNewRequests(fixture);
        expect(
          yield* fixture.handle.exitCode.pipe(Effect.timeout("5 seconds")),
        ).toBe(1);
        const elapsed = yield* shutdownElapsed(fixture);
        expect(elapsed).toBeGreaterThanOrEqual(1500);
        expect(elapsed).toBeLessThan(2000);
        expect(Result.isFailure(yield* Fiber.join(response))).toBe(true);
        yield* waitForOutput(fixture, "shutdown deadline exceeded");
        expect(fixture.output()).toContain("request finalized");
        expect(fixture.output()).toContain("instance finalizing");
        expect(fixture.output()).not.toContain("instance finalized");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R03/R07 run-only jobs survive SIGTERM until the worker drains and releases its client",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({ RUN_ONLY: "1", WORKERS: "1" });
        yield* fixture.signal("SIGTERM");
        yield* waitForOutput(fixture, "worker1 stop started");
        yield* fixture.signal("SIGTERM");
        yield* fixture.signal("SIGINT");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        const output = fixture.output();
        assertWorkerOrder(output, "worker1");
        before(output, "worker1 stopped", "worker1 job 1 completed");
        before(output, "worker1 job 1 completed", "worker1 drained");
        before(output, "worker1 client released", "instance finalizing");
        expect(output.match(/worker1 stop started/g)?.length).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R03/R07 mixed HTTP and jobs begin stopping concurrently and retain shared dependencies",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          WORKERS: "2",
          NESTED_WORKER: "1",
        });
        const response = yield* fixture.get("/slow").pipe(
          Effect.flatMap((response) => response.text),
          Effect.forkChild,
        );
        yield* waitForOutput(fixture, "request started");
        yield* fixture.signal("SIGINT");
        yield* refusesNewRequests(fixture);
        expect(yield* Fiber.join(response)).toBe("completed");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        const output = fixture.output();
        for (const name of ["worker1", "worker2"]) {
          assertWorkerOrder(output, name);
          before(output, `${name} stopped`, "response ready");
          before(output, `${name} client released`, "instance finalizing");
        }
        assertFinalizerOrder(output, "response ready");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R04 SIGINT preserves a slow stream's length and checksum while jobs drain",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({ WORKERS: "1" });
        const first = yield* Deferred.make<void>();
        const chunks: string[] = [];
        const response = yield* fixture.get("/stream-large").pipe(
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.decodeText,
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  chunks.push(chunk);
                  Deferred.doneUnsafe(first, Effect.void);
                }),
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        yield* fixture.signal("SIGINT");
        yield* refusesNewRequests(fixture);
        yield* Fiber.join(response);
        const actual = chunks.join("");
        const expected = Array.from({ length: 16 }, (_, index) =>
          String(index).padStart(2, "0").repeat(8192),
        ).join("");
        expect(actual.length).toBe(262144);
        const hashes = yield* Effect.sync(() =>
          [actual, expected].map((body) =>
            createHash("sha256").update(body).digest("hex"),
          ),
        );
        expect(hashes[0]).toBe(hashes[1]);
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        assertWorkerOrder(fixture.output(), "worker1");
        assertFinalizerOrder(fixture.output(), "chunk last");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R05 delayed acquisition stop is a barrier without delaying another worker",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          RUN_ONLY: "1",
          WORKERS: "2",
          WORKER_MODE: "stop-delay",
        });
        yield* fixture.signal("SIGTERM");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        const output = fixture.output();
        assertWorkerOrder(output, "worker1");
        assertWorkerOrder(output, "worker2");
        before(output, "worker2 stopped", "worker1 stopped");
        before(output, "worker1 claim 2", "worker1 stopped");
        const claims = [...output.matchAll(/worker1 claim (\d+)/g)].map(
          (match) => match[1],
        );
        for (const id of claims) {
          before(output, `worker1 job ${id} completed`, "worker1 drained");
        }
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R05 a failed stop checkpoints without a success drain and cannot suppress HTTP or another worker",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          WORKERS: "2",
          WORKER_MODE: "stop-fail",
        });
        const response = yield* fixture.get("/slow").pipe(
          Effect.flatMap((response) => response.text),
          Effect.forkChild,
        );
        yield* waitForOutput(fixture, "request started");
        yield* fixture.signal("SIGTERM");
        yield* refusesNewRequests(fixture);
        expect(yield* Fiber.join(response)).toBe("completed");
        expect(yield* fixture.handle.exitCode).toBe(1);
        yield* waitForOutput(fixture, "instance finalized");
        const output = fixture.output();
        expect(output).toContain("worker1 checkpoint");
        expect(output).not.toContain("worker1 drain started");
        expect(output).not.toContain("worker1 stopped");
        before(output, "worker1 checkpoint", "worker1 work scope closed");
        before(output, "worker1 work scope closed", "worker1 client released");
        before(output, "worker1 client released", "instance finalizing");
        assertWorkerOrder(output, "worker2");
        before(output, "worker2 client released", "instance finalizing");
        assertFinalizerOrder(output, "response ready");
        expect(output).toContain("Managed process cleanup failed");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  for (const mode of ["stop-hang", "job-hang"]) {
    it.live(
      `R05 ${mode} cannot suppress another worker or extend the absolute hard deadline`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture({
            WORKERS: "2",
            WORKER_MODE: mode,
            ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "2000",
          });
          const response = yield* fixture.get("/slow").pipe(
            Effect.flatMap((response) => response.text),
            Effect.forkChild,
          );
          yield* waitForOutput(fixture, "request started");
          const started = yield* Effect.sync(() => performance.now());
          yield* fixture.signal("SIGTERM");
          yield* refusesNewRequests(fixture);
          expect(yield* Fiber.join(response)).toBe("completed");
          yield* fixture.signal("SIGINT");
          expect(yield* fixture.handle.exitCode).toBe(1);
          const elapsed = yield* Effect.sync(() => performance.now() - started);
          expect(elapsed).toBeGreaterThanOrEqual(1700);
          expect(elapsed).toBeLessThan(2200);
          yield* waitForOutput(fixture, "shutdown deadline exceeded");
          const output = fixture.output();
          assertWorkerOrder(output, "worker2");
          expect(output).toContain("request finalized");
          expect(output).not.toContain("instance finalizing");
          expect(output).not.toContain("worker1 client released");
          expect(output.match(/worker1 stop started/g)?.length).toBe(1);
          if (mode === "stop-hang")
            expect(output).not.toContain("worker1 drain started");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  for (const mode of ["normal", "error"]) {
    it.live(
      `R03 ${mode} run completion cleans jobs and shared dependencies without a signal`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture({
            RUN_ONLY: "1",
            WORKERS: "1",
            WORKER_MODE: mode,
          });
          expect(yield* fixture.handle.exitCode).toBe(
            mode === "normal" ? 0 : 1,
          );
          yield* waitForOutput(fixture, "instance finalized");
          assertWorkerOrder(fixture.output(), "worker1");
          before(
            fixture.output(),
            "worker1 client released",
            "instance finalizing",
          );
          if (mode === "error")
            expect(fixture.output()).toContain("worker failed");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  it.live(
    "R03 a completed background runner does not stop a still-running HTTP service",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          WORKERS: "1",
          WORKER_MODE: "normal",
        });
        yield* waitForOutput(fixture, "worker1 client released");
        yield* Effect.sleep("2 seconds");
        expect((yield* fixture.get("/health")).status).toBe(200);
        yield* fixture.signal("SIGTERM");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        assertWorkerOrder(fixture.output(), "worker1");
        expect(fixture.output()).not.toContain("deadline exceeded");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R03 a runner error initiates sibling cleanup while an HTTP response is still in flight",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          WORKERS: "2",
          WORKER_MODE: "error-delay",
        });
        const response = yield* fixture.get("/slow").pipe(
          Effect.flatMap((response) => response.text),
          Effect.forkChild,
        );
        yield* waitForOutput(fixture, "worker1 stop started");
        yield* refusesNewRequests(fixture);
        expect(yield* Fiber.join(response)).toBe("completed");
        expect(yield* fixture.handle.exitCode).toBe(1);
        yield* waitForOutput(fixture, "instance finalized");
        const output = fixture.output();
        for (const name of ["worker1", "worker2"]) {
          assertWorkerOrder(output, name);
          before(output, `${name} stopped`, "response ready");
          before(output, `${name} client released`, "instance finalizing");
        }
        assertFinalizerOrder(output, "response ready");
        expect(output).toContain("worker failed");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  for (const route of ["/slow", "/stream"]) {
    it.live(
      `review R2 ${route} request cleanup defects survive SIGTERM and independent cleanup`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture({
            WORKERS: "2",
            FAIL_REQUEST_FINALIZER: "1",
          });
          const response = yield* fixture.get(route).pipe(
            Effect.flatMap((response) => response.text),
            Effect.forkChild,
          );
          yield* waitForOutput(fixture, "request started");
          yield* fixture.signal("SIGTERM");
          expect(yield* Fiber.join(response)).toBe(
            route === "/slow" ? "completed" : "first\nsecond\nlast\n",
          );
          expect(yield* fixture.handle.exitCode).toBe(1);
          yield* waitForOutput(fixture, "instance finalized");
          const output = fixture.output();
          expect(output).toContain("Managed HTTP request cleanup failed");
          expect(output).toContain("request cleanup defect");
          before(output, "request dependency released", "instance finalizing");
          assertWorkerOrder(output, "worker1");
          assertWorkerOrder(output, "worker2");
          before(output, "worker2 client released", "instance finalizing");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  it.live(
    "review R2 ordinary handler defects do not become managed cleanup failures",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture();
        expect((yield* fixture.get("/handler-error")).status).toBe(500);
        yield* waitForOutput(fixture, "request dependency released");
        yield* fixture.signal("SIGTERM");
        expect(yield* fixture.handle.exitCode).toBe(0);
        expect(fixture.output()).toContain("ordinary handler defect");
        expect(fixture.output()).not.toContain(
          "Managed HTTP request cleanup failed",
        );
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "review R2 expected client abort does not become a cleanup failure",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture();
        const response = yield* fixture.get("/hang").pipe(Effect.forkChild);
        yield* waitForOutput(fixture, "request started");
        yield* Fiber.interrupt(response);
        yield* waitForOutput(fixture, "request dependency released");
        yield* fixture.signal("SIGTERM");
        expect(yield* fixture.handle.exitCode).toBe(0);
        expect(fixture.output()).not.toContain(
          "Managed HTTP request cleanup failed",
        );
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  for (const exit of ["normal", "error"]) {
    it.live(
      `review R1 opaque nested ${exit} cleanup is bounded from an actual signal, not its hidden body exit`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture({
            WORKERS: "2",
            NESTED_WORKER: "1",
            WORKER_MODE: "stop-hang",
            RUN_EXIT: exit,
            ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "2000",
          });
          yield* waitForOutput(fixture, "worker1 stop started");
          yield* Effect.sleep("2200 millis");
          expect((yield* fixture.get("/health")).status).toBe(200);
          expect(fixture.output()).not.toContain("shutdown deadline exceeded");
          expect(fixture.output()).not.toContain("worker2 stop started");
          const signaled = yield* Effect.sync(() => performance.now());
          yield* fixture.signal("SIGTERM");
          yield* refusesNewRequests(fixture);
          expect(yield* fixture.handle.exitCode).toBe(1);
          const elapsed = yield* Effect.sync(
            () => performance.now() - signaled,
          );
          expect(elapsed).toBeGreaterThanOrEqual(1700);
          expect(elapsed).toBeLessThan(2500);
          yield* waitForOutput(fixture, "shutdown deadline exceeded");
          assertWorkerOrder(fixture.output(), "worker2");
          expect(fixture.output()).not.toContain("instance finalizing");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it.live(
      `review R1 recommended scoped never worker drains independently on ${signal}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture({
            RUN_ONLY: "1",
            WORKERS: "1",
            NESTED_WORKER: "1",
          });
          yield* fixture.signal(signal);
          expect(yield* fixture.handle.exitCode).toBe(0);
          yield* waitForOutput(fixture, "instance finalized");
          assertWorkerOrder(fixture.output(), "worker1");
          before(
            fixture.output(),
            "worker1 job 1 completed",
            "worker1 client released",
          );
          before(
            fixture.output(),
            "worker1 client released",
            "instance finalizing",
          );
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  for (const exit of ["normal", "error"]) {
    it.live(
      `R05 ${exit} completion starts a deadline before runtime-owned scope cleanup`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture({
            RUN_ONLY: "1",
            WORKERS: "1",
            WORKER_MODE: "stop-hang",
            RUN_EXIT: exit,
            ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "2000",
          });
          expect(yield* fixture.handle.exitCode).toBe(1);
          yield* waitForOutput(fixture, "shutdown deadline exceeded");
          expect(fixture.output()).toContain("worker1 stop started");
          expect(fixture.output()).not.toContain("instance finalizing");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  it.live(
    "R05 an initially empty job set cannot bypass a delayed acquisition stop",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          RUN_ONLY: "1",
          WORKERS: "1",
          WORKER_MODE: "stop-delay-empty",
        });
        expect(fixture.output()).not.toContain("worker1 claim");
        yield* fixture.signal("SIGTERM");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        const output = fixture.output();
        before(output, "worker1 stop started", "worker1 claim 1");
        assertWorkerOrder(output, "worker1");
        for (const match of output.matchAll(/worker1 claim (\d+)/g)) {
          before(
            output,
            `worker1 job ${match[1]} completed`,
            "worker1 drained",
          );
        }
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R05 dependency finalizer failure retains a nonzero outcome after successful drains",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          RUN_ONLY: "1",
          WORKERS: "2",
          FAIL_FINALIZER: "1",
        });
        yield* fixture.signal("SIGTERM");
        expect(yield* fixture.handle.exitCode).toBe(1);
        yield* waitForOutput(fixture, "dependency finalizer failed");
        assertWorkerOrder(fixture.output(), "worker1");
        assertWorkerOrder(fixture.output(), "worker2");
        before(
          fixture.output(),
          "worker2 client released",
          "instance finalizing",
        );
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R06 accepts the 300s parser boundary without waiting for that deadline",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          RUN_ONLY: "1",
          WORKERS: "1",
          WORKER_MODE: "normal",
          ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "300000",
        });
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "R06 run-only workers without opt-in retain native signal termination",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          RUN_ONLY: "1",
          WORKERS: "1",
          ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: undefined,
        });
        yield* fixture.signal("SIGINT");
        expect(
          Result.isFailure(yield* fixture.handle.exitCode.pipe(Effect.result)),
        ).toBe(true);
        expect(fixture.output()).not.toContain("worker1 stop started");
        expect(fixture.output()).not.toContain("instance finalizing");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  for (const [name, env] of [
    [
      "Fly without the shutdown env",
      { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: undefined },
    ],
    ["unrelated hosts even with the Fly env", { UNMANAGED_HOST: "1" }],
  ] as const) {
    it.live(
      `R06 preserves default signal behavior for ${name}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture(env);
          const response = yield* fixture
            .get("/slow")
            .pipe(Effect.result, Effect.forkChild);
          yield* waitForOutput(fixture, "request started");
          yield* fixture.signal("SIGTERM");
          const exit = yield* fixture.handle.exitCode.pipe(Effect.result);
          expect(Result.isFailure(exit)).toBe(true);
          expect(Result.isFailure(yield* Fiber.join(response))).toBe(true);
          expect(fixture.output()).not.toContain("response ready");
          expect(fixture.output()).not.toContain("instance finalizing");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  for (const timeout of [
    "0",
    "-1",
    "1.5",
    "invalid",
    "300001",
    "9007199254740992",
  ]) {
    it.live(
      `R06 rejects invalid shutdown timeout ${timeout}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture(
            { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: timeout },
            false,
          );
          expect(yield* fixture.handle.exitCode).toBe(1);
          yield* waitForOutput(fixture, "must be a positive integer");
          expect(fixture.output()).not.toContain("ready");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }
});
