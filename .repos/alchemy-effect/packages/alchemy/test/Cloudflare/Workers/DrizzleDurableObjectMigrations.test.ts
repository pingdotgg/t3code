import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import DrizzleDurableObjectWorker from "./fixtures/drizzle-do/worker.ts";

for (const dev of [true, false]) {
  const state = dev ? Alchemy.inMemoryState() : Cloudflare.state();
  const mode = dev ? "local" : "live";
  describe(
    mode,
    { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
    () => {
      const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
        providers: Cloudflare.providers(),
        state,
        dev,
      });

      /**
       * End-to-end coverage for drizzle-kit's Durable Object migrations flow: the
       * checked-in `fixtures/drizzle-do/drizzle/` directory is exactly what
       * `drizzle-kit generate` emits for `driver: "durable-sqlite"` — a
       * `migrations.js` importing each migration's `.sql` file — and the DO runs
       * `drizzle-orm/durable-sqlite`'s `migrate` at instance init. The deploy
       * itself asserts the bundler resolves bare `.sql` imports as text modules.
       */
      const Stack = Alchemy.Stack(
        `DrizzleDurableObjectMigrationsStack-${mode}`,
        { providers: Cloudflare.providers(), state },
        Effect.gen(function* () {
          const worker = yield* DrizzleDurableObjectWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      const stack = beforeAll(deploy(Stack));
      afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

      const readinessSchedule = Schedule.min([
        Schedule.exponential("500 millis"),
        Schedule.spaced("3 seconds"),
      ]);

      test(
        `${mode}: DO runs drizzle migrations at init and serves drizzle queries`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const client = yield* HttpClient.HttpClient;
          // A fresh instance name per run so the migrated table starts empty
          // even when the stack is kept alive between runs (NO_DESTROY).
          const instance = yield* Effect.sync(() => crypto.randomUUID());

          // Marker-anchored readiness: a freshly-enabled workers.dev hostname can
          // serve Cloudflare's placeholder page with a 200 before the deployed
          // Worker propagates, so gate on the route's JSON body, not the status.
          const addUser = (name: string) =>
            client.post(`${url}/users?do=${instance}&name=${name}`).pipe(
              Effect.flatMap((res) => res.text),
              Effect.flatMap((body) =>
                body.includes(`"ok":true`)
                  ? Effect.succeed((JSON.parse(body) as { id: number }).id)
                  : Effect.fail(
                      new Error(`Worker not ready: ${body.slice(0, 200)}`),
                    ),
              ),
              Effect.retry({ schedule: readinessSchedule, times: 15 }),
            );

          const gimli = yield* addUser("gimli");
          yield* addUser("legolas");
          yield* client
            .post(`${url}/posts?do=${instance}&user=${gimli}&title=axes`)
            .pipe(Effect.flatMap((res) => res.json));

          const res = yield* client.get(`${url}/users?do=${instance}`);
          expect(res.status).toBe(200);
          const body = (yield* res.json) as { names: string[] };
          expect(body.names).toEqual(["gimli", "legolas"]);

          // Relational query through the `relations` config.
          const withPosts = yield* client.get(
            `${url}/users-with-posts?do=${instance}`,
          );
          expect(withPosts.status).toBe(200);
          const relational = (yield* withPosts.json) as {
            users: { name: string; posts: string[] }[];
          };
          expect(relational.users).toEqual([
            { name: "gimli", posts: ["axes"] },
            { name: "legolas", posts: [] },
          ]);

          // Typed error handling: a failing query is caught inside the DO with
          // Effect.catchTag rather than escaping as a defect.
          const missing = yield* client.get(
            `${url}/missing-table?do=${instance}`,
          );
          expect(missing.status).toBe(200);
          const caught = (yield* missing.json) as { result: string };
          expect(caught.result).toMatch(
            /^caught:(SqlError|EffectDrizzleQueryError)$/,
          );
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 120_000 },
      );

      const requestRegression = (route: string, instanceName?: string) =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          if (dev) expect(url).toMatch(/^http:\/\/localhost:\d+$/);
          const client = yield* HttpClient.HttpClient;
          const instance =
            instanceName ?? (yield* Effect.sync(() => crypto.randomUUID()));
          const ready = yield* requestWorker(
            HttpClientRequest.get(`${url}/users?do=${instance}`),
          );
          expect(ready.status).toBe(200);
          expect(yield* ready.json).toEqual({ names: [] });
          return yield* client.get(`${url}/${route}&do=${instance}`).pipe(
            Effect.flatMap((response) =>
              Effect.gen(function* () {
                const body = yield* response.text;
                if (response.status !== 200) {
                  return yield* Effect.fail(
                    new Error(
                      `Regression returned ${response.status}: ${body}`,
                    ),
                  );
                }
                return yield* Effect.sync(() => JSON.parse(body));
              }),
            ),
            Effect.timeout("10 seconds"),
          );
        });

      test(
        `${mode}: SQLite clock RPC works independently of transaction input gates`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const client = yield* HttpClient.HttpClient;
          const probes = yield* Effect.forEach(
            [false, true],
            (view) =>
              Effect.gen(function* () {
                const instance = yield* Effect.sync(() => crypto.randomUUID());
                yield* requestRegression("users?", instance);
                const outcomes = yield* Effect.forEach(
                  [
                    `sqlite-gate?view=${view}`,
                    "sqlite-clock?direct=true",
                    "sqlite-clock?direct=false",
                    `sqlite-gate?view=${view}`,
                  ],
                  (route) =>
                    client.get(`${url}/${route}&do=${instance}`).pipe(
                      Effect.flatMap((response) =>
                        response.text.pipe(
                          Effect.map((body) => ({
                            route,
                            status: response.status,
                            body,
                          })),
                        ),
                      ),
                      Effect.timeout("10 seconds"),
                    ),
                  { concurrency: 1 },
                );
                return { instance, outcomes };
              }),
            { concurrency: 1 },
          );
          yield* Effect.logInfo("SQLite clock diagnostic", { url, probes });
          for (const probe of probes) {
            for (const outcome of probe.outcomes) {
              expect(outcome.status).toBe(200);
              const body = yield* Effect.sync(() => JSON.parse(outcome.body));
              expect(body).toEqual(
                outcome.route.startsWith("sqlite-gate")
                  ? {
                      enteredAfterOuter: false,
                      sameTransaction: true,
                      samePermit: true,
                      sameTransactionContext: true,
                      restoredScheduler: true,
                      finishedBeforeClear: true,
                    }
                  : { clock: "ready" },
              );
            }
          }
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 120_000 },
      );

      for (const view of [false, true]) {
        test(
          `${mode}: SQLite input gate yields before releasing the earlier timer (view=${view})`,
          Effect.gen(function* () {
            const result = yield* requestRegression(`sqlite-gate?view=${view}`);
            expect(result).toEqual({
              enteredAfterOuter: false,
              sameTransaction: true,
              samePermit: true,
              sameTransactionContext: true,
              restoredScheduler: true,
              finishedBeforeClear: true,
            });
          }),
          { tags: [...(dev ? ["local"] : ["live"])], timeout: 120_000 },
        );
      }

      test(
        `${mode}: SQLite failure, defect and interruption roll back and release the permit`,
        Effect.gen(function* () {
          const result = yield* requestRegression("sqlite-rollback?");
          expect(result).toEqual({
            failed: true,
            defect: true,
            interrupted: true,
            waitingForPermit: true,
            rowsAfterRollback: [],
            finalRows: [{ name: "committed" }],
            finalized: [
              "caller:failed:true",
              "caller:defect:true",
              "caller:interrupted:true",
              "caller:committed:true",
            ],
            callerScopePreserved: true,
          });
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 120_000 },
      );
    },
  );
}
