import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { afterEach, vi } from "vitest";
import * as Service from "../bindings/Service.ts";
import * as Runtime from "../Runtime.ts";
import * as Workerd from "../workerd/Workerd.ts";
import { localRuntimeLayer } from "./helpers/runtime.ts";

/**
 * `/crash` exhausts the isolate's heap. With a small `--max-old-space-size`
 * V8 aborts the process the way it does in a long dev session, only faster.
 */
const CRASHING_SCRIPT = `
const hog = [];
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/crash") {
      for (;;) hog.push(new Array(1_000_000).fill(url.pathname));
    }
    return env.SERVICE ? env.SERVICE.fetch(request) : new Response("hello");
  },
};
`;

const fetchText = (url: URL) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return await response.text();
  });

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Runtime restart",
  (it) => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    it.effect(
      "releases each process generation and bounds repeated crash recovery",
      () =>
        Effect.gen(function* () {
          vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
          const runtime = yield* Runtime.Runtime;
          const workerd = yield* Workerd.Workerd;
          const serve = workerd.serve;
          let active = 0;
          let started = 0;
          vi.spyOn(workerd, "serve").mockImplementation((...args) =>
            Effect.gen(function* () {
              expect(active).toBe(0);
              const ports = yield* serve(...args);
              active++;
              started++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  active--;
                }),
              );
              return ports;
            }),
          );
          const exits: Array<Workerd.WorkerdExit> = [];
          const url = yield* runtime.start({
            name: "restarting",
            compatibilityDate: "2026-03-10",
            compatibilityFlags: [],
            bindings: [],
            modules: [
              { name: "main.js", type: "ESModule", content: CRASHING_SCRIPT },
            ],
            onRestart: (exit) => {
              exits.push(exit);
            },
          });
          expect(yield* fetchText(new URL("/hello", url))).toBe("hello");

          for (let crash = 1; crash <= 3; crash++) {
            yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
            const answer = yield* fetchText(new URL("/hello", url)).pipe(
              Effect.retry({
                schedule: Schedule.spaced("250 millis"),
                times: 10,
              }),
            );
            expect(answer).toBe("hello");
            expect(exits).toHaveLength(crash);
            expect(exits[crash - 1].stderr).toContain(
              "JavaScript heap out of memory",
            );
            expect(active).toBe(1);
          }
          // The fourth crash exhausts the rolling restart budget.
          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
          yield* Effect.sleep(1_500);
          expect(started).toBe(4);
          expect(active).toBe(0);
          expect(exits).toHaveLength(3);
          expect(
            yield* fetchText(new URL("/hello", url)).pipe(Effect.exit),
          ).toMatchObject({ _tag: "Failure" });
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "restores current service targets and keeps receiving registry updates",
      () =>
        Effect.gen(function* () {
          vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
          const runtime = yield* Runtime.Runtime;
          const parent = yield* Effect.scope;
          let providerScope = yield* Scope.fork(parent);
          const startProvider = (version: string) =>
            runtime
              .start({
                name: "restart-dependency",
                compatibilityDate: "2026-03-10",
                compatibilityFlags: [],
                bindings: [],
                modules: [
                  {
                    name: "main.js",
                    type: "ESModule",
                    content: `export default { fetch: () => new Response("${version}") };`,
                  },
                ],
              })
              .pipe(Scope.provide(providerScope));
          yield* startProvider("one");
          const url = yield* runtime.start({
            name: "restart-consumer",
            compatibilityDate: "2026-03-10",
            compatibilityFlags: [],
            bindings: [
              Service.local({
                binding: "SERVICE",
                scriptName: "restart-dependency",
              }),
            ],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: CRASHING_SCRIPT,
              },
            ],
          });
          const expectVersion = (version: string) =>
            fetchText(url).pipe(
              Effect.filterOrFail(
                (text) => text === version,
                () => new Error("stale service target"),
              ),
              Effect.retry({
                schedule: Schedule.spaced("250 millis"),
                times: 10,
              }),
              Effect.tap((text) =>
                Effect.sync(() => expect(text).toBe(version)),
              ),
            );
          yield* expectVersion("one");
          yield* Scope.close(providerScope, Exit.void);
          providerScope = yield* Scope.fork(parent);
          yield* startProvider("two");
          yield* expectVersion("two");

          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
          yield* expectVersion("two");

          yield* Scope.close(providerScope, Exit.void);
          providerScope = yield* Scope.fork(parent);
          yield* startProvider("three");
          yield* expectVersion("three");
        }),
      { timeout: 60_000 },
    );

    for (const crashBeforeClose of [false, true]) {
      it.effect(
        `does not restart after scope closure (crash: ${crashBeforeClose})`,
        () =>
          Effect.gen(function* () {
            vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
            const workerd = yield* Workerd.Workerd;
            const serve = vi.spyOn(workerd, "serve");
            const exits: Array<Workerd.WorkerdExit> = [];
            yield* Effect.gen(function* () {
              const runtime = yield* Runtime.Runtime;
              const url = yield* runtime.start({
                name: "closing",
                compatibilityDate: "2026-03-10",
                compatibilityFlags: [],
                bindings: [],
                modules: [
                  {
                    name: "main.js",
                    type: "ESModule",
                    content: CRASHING_SCRIPT,
                  },
                ],
                onRestart: (exit) => {
                  exits.push(exit);
                },
              });
              expect(yield* fetchText(new URL("/hello", url))).toBe("hello");
              if (crashBeforeClose) {
                yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
              }
            }).pipe(Effect.scoped);
            // Give a wrongly reported exit time to arrive.
            yield* Effect.sleep(1_000);
            expect(serve).toHaveBeenCalledTimes(1);
            expect(exits).toHaveLength(0);
          }),
        { timeout: 30_000 },
      );
    }
  },
);
