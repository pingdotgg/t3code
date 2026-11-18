import { OptimizerStartError, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";

import type { OptimizerProbeDependencies } from "./OptimizerProbeService.ts";
import type { ProcessRunInput, ProcessRunOutput } from "../processRunner.ts";
import {
  makeWith,
  parseHeadroomSavings,
  parseHeadroomSavingsHistory,
} from "./OptimizerProbeService.ts";

const success = (stdout: string): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

type ProbeDependenciesWithoutLifecycle = Omit<
  OptimizerProbeDependencies,
  "spawnHeadroomProxy" | "sleep" | "getHeadroomUpstream"
> &
  Partial<Pick<OptimizerProbeDependencies, "spawnHeadroomProxy" | "sleep" | "getHeadroomUpstream">>;

const makeProbe = (dependencies: ProbeDependenciesWithoutLifecycle) =>
  makeWith({
    ...dependencies,
    spawnHeadroomProxy:
      dependencies.spawnHeadroomProxy ??
      (() =>
        Effect.fail(
          new OptimizerStartError({ message: "No Headroom process stub was provided." }),
        )),
    sleep: dependencies.sleep ?? (() => Effect.void),
    getHeadroomUpstream: dependencies.getHeadroomUpstream ?? Effect.succeed({}),
  });

describe("OptimizerProbeService", () => {
  it.effect("discovers fixed optimizer rows and normalizes host-wide savings", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<ProcessRunInput>>([]);
      const service = yield* makeProbe({
        run: (input) =>
          Ref.update(commands, (current) => [...current, input]).pipe(
            Effect.as(
              success(
                input.args[0] === "gain"
                  ? '{"summary":{"total_commands":2,"total_input":100,"total_output":20,"total_saved":80}}'
                  : input.command === "rtk"
                    ? "rtk 0.24.1"
                    : input.command === "/tools/cbm"
                      ? "codebase-memory-mcp 1.2.3"
                      : "headroom 0.9.0",
              ),
            ),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: () =>
          Effect.succeed({
            savings: { total_tokens: 999 },
            display_session: { tokens_saved: 321 },
          }),
        fetchHeadroomHealth: () =>
          Effect.succeed({ service: "headroom-proxy", status: "healthy", version: "0.9.0" }),
        fetchHeadroomHistory: () =>
          Effect.succeed({
            series: {
              hourly: [
                { timestamp: "2026-01-01T01:00:00Z", tokens_saved: 12 },
                { timestamp: "invalid", tokens_saved: 99 },
              ],
              daily: [{ timestamp: "2026-01-01T00:00:00Z", tokens_saved: 33 }],
              weekly: [{ timestamp: "2025-12-29T00:00:00Z", tokens_saved: -1 }],
            },
          }),
        getCbmBinaryPath: Effect.succeed("/tools/cbm"),
        getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
        listCbmIndexes: Effect.succeed([
          {
            projectId: ProjectId.make("project-1"),
            repoPath: "/repo",
            state: "ready",
            checkedAt: "2026-01-01T00:00:00.000Z",
            nodeCount: 12,
            edgeCount: 34,
          },
        ]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
        nowMs: Effect.succeed(0),
      });

      const snapshot = yield* service.getStatus({});
      expect(snapshot.optimizers).toEqual([
        {
          id: "rtk",
          installed: true,
          version: "0.24.1",
          mode: "cli-wrapper",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "headroom",
          installed: true,
          version: "0.9.0",
          running: true,
          mode: "detected-proxy",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "cbm",
          installed: true,
          version: "1.2.3",
          mode: "stdio-mcp",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(snapshot.savings).toEqual([
        { source: "rtk", scope: "environment", window: "all-time", tokensSaved: 80 },
        { source: "headroom", scope: "environment", window: "session", tokensSaved: 321 },
      ]);
      expect(snapshot.savingsHistory).toEqual([
        {
          source: "headroom",
          scope: "environment",
          interval: "hour",
          timestamp: "2026-01-01T01:00:00.000Z",
          tokensSaved: 12,
        },
        {
          source: "headroom",
          scope: "environment",
          interval: "day",
          timestamp: "2026-01-01T00:00:00.000Z",
          tokensSaved: 33,
        },
      ]);
      expect(snapshot.cbmIndexes[0]).toMatchObject({ state: "ready", nodeCount: 12 });
      expect((yield* Ref.get(commands)).some((input) => input.command === "/tools/cbm")).toBe(true);
    }),
  );

  it.effect("forces a fresh read when a startup refresh waits behind another refresh", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const headroomCalls = yield* Ref.make(0);
      const nowMs = yield* Ref.make(0);
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const service = yield* makeProbe({
        run: (input) =>
          Ref.updateAndGet(calls, (current) => current + 1).pipe(
            Effect.as(
              success(input.args[0] === "gain" ? '{"summary":{"total_saved":1}}' : "tool 1.2.3"),
            ),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: () =>
          Ref.updateAndGet(headroomCalls, (current) => current + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.succeed({ display_session: { tokens_saved: 1 } })
                : Deferred.succeed(refreshStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseRefresh)),
                    Effect.as({ display_session: { tokens_saved: 1 } }),
                  ),
            ),
          ),
        fetchHeadroomHealth: () => Effect.succeed({ service: "headroom-proxy", status: "healthy" }),
        fetchHeadroomHistory: () => Effect.succeed({ series: {} }),
        getCbmBinaryPath: Effect.succeed("cbm"),
        getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
        listCbmIndexes: Effect.succeed([]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
        nowMs: Ref.get(nowMs),
      });

      yield* service.getStatus({});
      const afterFirst = yield* Ref.get(calls);
      yield* service.getStatus({});
      expect(yield* Ref.get(calls)).toBe(afterFirst);
      yield* Ref.set(nowMs, 5_000);
      const firstRefresh = yield* service.getStatus({ refresh: true }).pipe(Effect.forkChild);
      yield* Deferred.await(refreshStarted);
      const secondRefresh = yield* service
        .getStatus({ refresh: true, force: true })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(firstRefresh);
      yield* Fiber.join(secondRefresh);
      expect(yield* Ref.get(calls)).toBe(afterFirst * 3);
      yield* service.getStatus({ refresh: true });
      expect(yield* Ref.get(calls)).toBe(afterFirst * 3);
    }),
  );

  it.effect("invalidates the cache when the configured CBM binary changes", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const cbmBinaryPath = yield* Ref.make("/tools/cbm-a");
      const service = yield* makeProbe({
        run: (input) =>
          Ref.update(commands, (current) => [...current, input.command]).pipe(
            Effect.as(
              success(input.args[0] === "gain" ? '{"summary":{"total_saved":1}}' : "tool 1.2.3"),
            ),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: () => Effect.succeed({ display_session: { tokens_saved: 1 } }),
        fetchHeadroomHealth: () => Effect.succeed({ service: "headroom-proxy", status: "healthy" }),
        fetchHeadroomHistory: () => Effect.succeed({ series: {} }),
        getCbmBinaryPath: Ref.get(cbmBinaryPath),
        getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
        listCbmIndexes: Effect.succeed([]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
        nowMs: Effect.succeed(0),
      });

      yield* service.getStatus({});
      yield* Ref.set(cbmBinaryPath, "/tools/cbm-b");
      yield* service.getStatus({});

      const observed = yield* Ref.get(commands);
      expect(observed.filter((command) => command === "/tools/cbm-a")).toHaveLength(1);
      expect(observed.filter((command) => command === "/tools/cbm-b")).toHaveLength(1);
    }),
  );

  it.effect("uses the configured Headroom origin and invalidates the cache when it changes", () =>
    Effect.gen(function* () {
      const observedOrigins = yield* Ref.make<ReadonlyArray<string>>([]);
      const headroomProxyUrl = yield* Ref.make("http://127.0.0.1:6767");
      const observe = (origin: string, result: unknown) =>
        Ref.update(observedOrigins, (current) => [...current, origin]).pipe(Effect.as(result));
      const service = yield* makeProbe({
        run: (input) =>
          Effect.succeed(
            success(input.args[0] === "gain" ? '{"summary":{"total_saved":1}}' : "tool 1.2.3"),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: (origin) => observe(origin, { display_session: { tokens_saved: 1 } }),
        fetchHeadroomHealth: (origin) =>
          observe(origin, { service: "headroom-proxy", status: "healthy" }),
        fetchHeadroomHistory: (origin) => observe(origin, { series: {} }),
        getCbmBinaryPath: Effect.succeed("cbm"),
        getHeadroomProxyUrl: Ref.get(headroomProxyUrl),
        listCbmIndexes: Effect.succeed([]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
        nowMs: Effect.succeed(0),
      });

      yield* service.getStatus({});
      yield* service.getStatus({});
      yield* Ref.set(headroomProxyUrl, "http://127.0.0.1:8787/");
      yield* service.getStatus({});

      expect(yield* Ref.get(observedOrigins)).toEqual([
        "http://127.0.0.1:6767",
        "http://127.0.0.1:6767",
        "http://127.0.0.1:6767",
        "http://127.0.0.1:8787",
        "http://127.0.0.1:8787",
        "http://127.0.0.1:8787",
      ]);
    }),
  );

  it.effect("recognizes the CLI health response when savings endpoints are unavailable", () =>
    Effect.gen(function* () {
      const service = yield* makeProbe({
        run: (input) =>
          Effect.succeed(
            success(
              input.args[0] === "gain"
                ? '{"summary":{"total_saved":1}}'
                : input.command === "headroom"
                  ? "headroom 0.33.0"
                  : "tool 1.2.3",
            ),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: () => Effect.succeed({ status: "not-stats" }),
        fetchHeadroomHealth: () =>
          Effect.succeed({
            service: "headroom-proxy",
            status: "healthy",
            version: "0.33.0",
          }),
        fetchHeadroomHistory: () => Effect.succeed({ status: "not-history" }),
        getCbmBinaryPath: Effect.succeed("cbm"),
        getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:8787"),
        listCbmIndexes: Effect.succeed([]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
        nowMs: Effect.succeed(0),
      });

      const snapshot = yield* service.getStatus({});
      expect(snapshot.optimizers.find((optimizer) => optimizer.id === "headroom")).toEqual({
        id: "headroom",
        installed: true,
        version: "0.33.0",
        running: true,
        mode: "detected-proxy",
        checkedAt: "2026-01-01T00:00:00.000Z",
        detail: "Headroom is running, but savings statistics are unavailable.",
      });
      expect(snapshot.savings).not.toContainEqual(expect.objectContaining({ source: "headroom" }));
      expect(snapshot.savingsHistory).toEqual([]);
    }),
  );

  it.effect("does not treat a non-healthy Headroom response as running", () =>
    Effect.gen(function* () {
      const service = yield* makeProbe({
        run: (input) =>
          Effect.succeed(
            success(
              input.args[0] === "gain"
                ? '{"summary":{"total_saved":1}}'
                : input.command === "headroom"
                  ? "unknown version"
                  : "tool 1.2.3",
            ),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: () => Effect.succeed({ display_session: { tokens_saved: 1 } }),
        fetchHeadroomHealth: () =>
          Effect.succeed({ service: "headroom-proxy", status: "unhealthy", version: "0.33.0" }),
        fetchHeadroomHistory: () => Effect.succeed({ series: {} }),
        getCbmBinaryPath: Effect.succeed("cbm"),
        getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:8787"),
        listCbmIndexes: Effect.succeed([]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
        nowMs: Effect.succeed(0),
      });

      const snapshot = yield* service.getStatus({});
      expect(snapshot.optimizers.find((optimizer) => optimizer.id === "headroom")).toMatchObject({
        installed: true,
        version: "0.33.0",
        running: false,
        detail: "The configured Headroom proxy reported an unhealthy status.",
      });
      expect(snapshot.savings).not.toContainEqual(expect.objectContaining({ source: "headroom" }));
    }),
  );

  it.effect("marks unusable version probes as not installed", () =>
    Effect.gen(function* () {
      const service = yield* makeProbe({
        run: (input) => {
          if (input.command === "rtk") return Effect.succeed(success("unknown version"));
          if (input.command === "/tools/cbm") {
            return Effect.succeed({
              ...success("codebase-memory-mcp 1.2.3"),
              code: ChildProcessSpawner.ExitCode(1),
            });
          }
          return Effect.succeed(success("headroom 0.9.0"));
        },
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: () => Effect.succeed("offline"),
        fetchHeadroomHealth: () => Effect.succeed("offline"),
        fetchHeadroomHistory: () => Effect.succeed("offline"),
        getCbmBinaryPath: Effect.succeed("/tools/cbm"),
        getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
        listCbmIndexes: Effect.succeed([]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
        nowMs: Effect.succeed(0),
      });

      const snapshot = yield* service.getStatus({});
      expect(snapshot.optimizers.find((optimizer) => optimizer.id === "rtk")).toMatchObject({
        installed: false,
        version: null,
        detail: "The installed version could not be parsed.",
      });
      expect(snapshot.optimizers.find((optimizer) => optimizer.id === "cbm")).toMatchObject({
        installed: false,
        version: "1.2.3",
        detail: "Version probe exited with code 1.",
      });
    }),
  );

  it.effect("starts Headroom on the configured port once and returns fresh status", () =>
    Effect.gen(function* () {
      const stops = yield* Effect.scoped(
        Effect.gen(function* () {
          const nowMs = yield* Ref.make(0);
          const healthCalls = yield* Ref.make(0);
          const starts = yield* Ref.make<
            ReadonlyArray<{ readonly host: string; readonly port: number }>
          >([]);
          const stops = yield* Ref.make(0);
          const service = yield* makeProbe({
            run: (input) =>
              Effect.succeed(
                success(
                  input.args[0] === "gain"
                    ? '{"summary":{"total_saved":1}}'
                    : input.command === "headroom"
                      ? "headroom 0.33.0"
                      : "tool 1.2.3",
                ),
              ),
            isMissingResult: () => Effect.succeed(false),
            fetchHeadroomStats: () => Effect.succeed("offline"),
            fetchHeadroomHealth: () =>
              Ref.updateAndGet(healthCalls, (current) => current + 1).pipe(
                Effect.map((attempt) =>
                  attempt === 1
                    ? { service: "other", status: "healthy" }
                    : { service: "headroom-proxy", status: "healthy", version: "0.33.0" },
                ),
              ),
            fetchHeadroomHistory: () => Effect.succeed("offline"),
            spawnHeadroomProxy: ({ host, port, scope }) =>
              Ref.update(starts, (current) => [...current, { host, port }]).pipe(
                Effect.andThen(
                  Scope.addFinalizer(
                    scope,
                    Ref.update(stops, (count) => count + 1),
                  ),
                ),
                Effect.as({
                  isRunning: Effect.succeed(true),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                }),
              ),
            getCbmBinaryPath: Effect.succeed("cbm"),
            getHeadroomProxyUrl: Effect.succeed("http://[::1]:8787"),
            listCbmIndexes: Effect.succeed([]),
            now: Effect.succeed("2026-01-01T00:00:00.000Z"),
            nowMs: Ref.get(nowMs),
            sleep: (milliseconds) => Ref.update(nowMs, (current) => current + milliseconds),
          });

          const snapshots = yield* Effect.all([service.startHeadroom(), service.startHeadroom()], {
            concurrency: "unbounded",
          });
          expect(yield* Ref.get(starts)).toEqual([{ host: "::1", port: 8787 }]);
          expect(
            snapshots.map(
              (snapshot) =>
                snapshot.optimizers.find((optimizer) => optimizer.id === "headroom")?.running,
            ),
          ).toEqual([true, true]);
          return stops;
        }),
      );
      expect(yield* Ref.get(stops)).toBe(1);
    }),
  );

  it.effect("reports early Headroom exit and releases its owned process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stops = yield* Ref.make(0);
        const service = yield* makeProbe({
          run: (input) =>
            Effect.succeed(
              success(input.command === "headroom" ? "headroom 0.33.0" : "tool 1.2.3"),
            ),
          isMissingResult: () => Effect.succeed(false),
          fetchHeadroomStats: () => Effect.succeed("offline"),
          fetchHeadroomHealth: () => Effect.succeed("offline"),
          fetchHeadroomHistory: () => Effect.succeed("offline"),
          spawnHeadroomProxy: ({ scope }) =>
            Scope.addFinalizer(
              scope,
              Ref.update(stops, (count) => count + 1),
            ).pipe(
              Effect.as({
                isRunning: Effect.succeed(false),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
              }),
            ),
          getCbmBinaryPath: Effect.succeed("cbm"),
          getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
          listCbmIndexes: Effect.succeed([]),
          now: Effect.succeed("2026-01-01T00:00:00.000Z"),
          nowMs: Effect.succeed(0),
        });

        const error = yield* service.startHeadroom().pipe(Effect.flip);
        expect(error.message).toContain("exited with code 9");
        expect(yield* Ref.get(stops)).toBe(1);
      }),
    ),
  );

  it.effect("releases an unready Headroom process when startup is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readinessStarted = yield* Deferred.make<void>();
        const healthCalls = yield* Ref.make(0);
        const stops = yield* Ref.make(0);
        const service = yield* makeProbe({
          run: (input) =>
            Effect.succeed(
              success(input.command === "headroom" ? "headroom 0.33.0" : "tool 1.2.3"),
            ),
          isMissingResult: () => Effect.succeed(false),
          fetchHeadroomStats: () => Effect.succeed("offline"),
          fetchHeadroomHealth: () =>
            Ref.updateAndGet(healthCalls, (current) => current + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.succeed("offline")
                  : Deferred.succeed(readinessStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    ),
              ),
            ),
          fetchHeadroomHistory: () => Effect.succeed("offline"),
          spawnHeadroomProxy: ({ scope }) =>
            Scope.addFinalizer(
              scope,
              Ref.update(stops, (count) => count + 1),
            ).pipe(
              Effect.as({
                isRunning: Effect.succeed(true),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              }),
            ),
          getCbmBinaryPath: Effect.succeed("cbm"),
          getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
          listCbmIndexes: Effect.succeed([]),
          now: Effect.succeed("2026-01-01T00:00:00.000Z"),
          nowMs: Effect.succeed(0),
        });

        const startup = yield* service.startHeadroom().pipe(Effect.forkChild);
        yield* Deferred.await(readinessStarted);
        yield* Fiber.interrupt(startup);
        expect(yield* Ref.get(stops)).toBe(1);
      }),
    ),
  );

  it.effect("releases Headroom acquired before a pending startup interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawnStarted = yield* Deferred.make<void>();
        const releaseSpawn = yield* Deferred.make<void>();
        const stops = yield* Ref.make(0);
        const service = yield* makeProbe({
          run: (input) =>
            Effect.succeed(
              success(input.command === "headroom" ? "headroom 0.33.0" : "tool 1.2.3"),
            ),
          isMissingResult: () => Effect.succeed(false),
          fetchHeadroomStats: () => Effect.succeed("offline"),
          fetchHeadroomHealth: () => Effect.succeed("offline"),
          fetchHeadroomHistory: () => Effect.succeed("offline"),
          spawnHeadroomProxy: ({ scope }) =>
            Effect.uninterruptible(
              Scope.addFinalizer(
                scope,
                Ref.update(stops, (count) => count + 1),
              ).pipe(
                Effect.andThen(Deferred.succeed(spawnStarted, undefined)),
                Effect.andThen(Deferred.await(releaseSpawn)),
                Effect.as({
                  isRunning: Effect.succeed(true),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                }),
              ),
            ),
          getCbmBinaryPath: Effect.succeed("cbm"),
          getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
          listCbmIndexes: Effect.succeed([]),
          now: Effect.succeed("2026-01-01T00:00:00.000Z"),
          nowMs: Effect.succeed(0),
        });

        const startup = yield* service.startHeadroom().pipe(Effect.forkChild);
        yield* Deferred.await(spawnStarted);
        const interruption = yield* Fiber.interrupt(startup).pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseSpawn, undefined);
        yield* Fiber.join(interruption);
        expect(yield* Ref.get(stops)).toBe(1);
      }),
    ),
  );

  it.effect("bounds startup when another service occupies the configured port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nowMs = yield* Ref.make(0);
        const stops = yield* Ref.make(0);
        const service = yield* makeProbe({
          run: (input) =>
            Effect.succeed(
              success(input.command === "headroom" ? "headroom 0.33.0" : "tool 1.2.3"),
            ),
          isMissingResult: () => Effect.succeed(false),
          fetchHeadroomStats: () => Effect.succeed("offline"),
          fetchHeadroomHealth: () => Effect.succeed({ service: "other", status: "healthy" }),
          fetchHeadroomHistory: () => Effect.succeed("offline"),
          spawnHeadroomProxy: ({ scope }) =>
            Scope.addFinalizer(
              scope,
              Ref.update(stops, (count) => count + 1),
            ).pipe(
              Effect.as({
                isRunning: Effect.succeed(true),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              }),
            ),
          getCbmBinaryPath: Effect.succeed("cbm"),
          getHeadroomProxyUrl: Effect.succeed("http://127.0.0.1:6767"),
          listCbmIndexes: Effect.succeed([]),
          now: Effect.succeed("2026-01-01T00:00:00.000Z"),
          nowMs: Ref.get(nowMs),
          sleep: (milliseconds) => Ref.update(nowMs, (current) => current + milliseconds),
        });

        const error = yield* service.startHeadroom().pipe(Effect.flip);
        expect(error.message).toContain("within 10 seconds");
        expect(error.message).toContain("no other service is using this port");
        expect(yield* Ref.get(stops)).toBe(1);
      }),
    ),
  );

  it("tolerates partial and malformed Headroom counters", () => {
    expect(parseHeadroomSavings({ tokens: { saved: 5 } })).toBeNull();
    expect(parseHeadroomSavings({ savings: { total_tokens: 5 } })).toBeNull();
    expect(parseHeadroomSavings({ display_session: { tokens_saved: 8 } })).toBe(8);
    expect(parseHeadroomSavings({ savings: { total_tokens: -1 } })).toBeNull();
    expect(parseHeadroomSavings({ savings: { total_tokens: "100" } })).toBeNull();
    expect(parseHeadroomSavings("not-an-object")).toBeNull();
  });

  it("omits malformed Headroom history points", () => {
    expect(
      parseHeadroomSavingsHistory({
        series: {
          monthly: [
            { timestamp: "2026-01-01T00:00:00Z", tokens_saved: 7 },
            { timestamp: "2026-02-01T00:00:00Z", tokens_saved: 1.5 },
            { timestamp: 5, tokens_saved: 9 },
          ],
        },
      }),
    ).toEqual([
      {
        source: "headroom",
        scope: "environment",
        interval: "month",
        timestamp: "2026-01-01T00:00:00.000Z",
        tokensSaved: 7,
      },
    ]);
  });
});
