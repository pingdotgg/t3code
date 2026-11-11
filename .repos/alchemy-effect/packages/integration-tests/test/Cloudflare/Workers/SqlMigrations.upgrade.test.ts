import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import UpgradeWorker from "./fixtures/sql-migrations-upgrade/worker.ts";

type State = { id: string; count: number; rows: { value: string }[] };

for (const dev of [true, false]) {
  describe(
    dev ? "local SQL migration updates" : "live SQL migration updates",
    { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
    () => {
      const { test } = Test.make({
        providers: Cloudflare.providers(),
        dev,
        stage: dev ? "sql-migrations-upgrade-local" : "sql-migrations-upgrade-live",
      });
      test.provider(
        "SQL-only changes update existing objects without replay or replacement",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped();
            yield* fs.writeFileString(
              path.join(dir, "0001_init.sql"),
              "CREATE TABLE items (value TEXT NOT NULL); INSERT INTO items VALUES ('seed');",
            );
            const config = ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ SQL_MIGRATIONS_DIRECTORY: dir }),
              yield* ConfigProvider.ConfigProvider,
            );
            const deploy = stack
              .deploy(
                Effect.gen(function* () {
                  const worker = yield* UpgradeWorker;
                  return {
                    url: worker.url.as<string>(),
                    namespaces: worker.durableObjectNamespaces,
                  };
                }),
              )
              .pipe(Effect.provideService(ConfigProvider.ConfigProvider, config));
            const first = yield* deploy;
            // Fresh and updated workers.dev hosts can answer Cloudflare's 404
            // placeholder before the script reaches them; requestWorker retries
            // only that pre-invocation placeholder.
            const read = (url: string) =>
              requestWorker(HttpClientRequest.get(url)).pipe(
                Effect.flatMap((response) =>
                  Effect.gen(function* () {
                    if (response.status !== 200)
                      return yield* Effect.fail(
                        new Error(`GET ${url}: ${response.status}: ${yield* response.text}`),
                      );
                    return yield* response.json;
                  }),
                ),
                Effect.map((value) => value as State),
                Effect.timeout("5 seconds"),
              );
            // A redeploy reaches a busy live Durable Object only once it goes
            // idle: Worker `exports` deploys carry no migration, so Cloudflare
            // keeps an activation that receives a request every few seconds on
            // the previous version indefinitely. Leave an idle gap between
            // probes so the object restarts on the new code.
            const probe = {
              schedule: Schedule.spaced(dev ? "3 seconds" : "15 seconds"),
              times: dev ? 10 : 5,
            };
            const ready = (url: string, count: number) =>
              read(url).pipe(
                Effect.filterOrFail(
                  (state) => state.count === count,
                  () => new Error("Migration version not ready"),
                ),
                Effect.retry(probe),
                Effect.timeout("90 seconds"),
              );
            const original = yield* ready(first.url, 1);
            expect(original.rows).toEqual([{ value: "seed" }]);
            yield* requestWorker(HttpClientRequest.post(first.url)).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
            );
            yield* fs.writeFileString(
              path.join(dir, "0002_append.sql"),
              "INSERT INTO items VALUES ('must-rollback'); INSERT INTO missing_table VALUES (1);",
            );
            const broken = yield* deploy;
            const failed = yield* requestWorker(HttpClientRequest.get(broken.url)).pipe(
              Effect.flatMap((response) =>
                response.text.pipe(Effect.map((body) => ({ status: response.status, body }))),
              ),
              Effect.timeout("5 seconds"),
              Effect.repeat({
                until: (response) =>
                  response.status === 500 &&
                  response.body.includes("Failed to apply SQL migration"),
                ...probe,
              }),
              Effect.timeout("90 seconds"),
            );
            expect(failed.status).toBe(500);
            expect(failed.body).toContain("Failed to apply SQL migration");
            yield* fs.writeFileString(
              path.join(dir, "0002_append.sql"),
              "INSERT INTO items VALUES ('migration-two');",
            );
            const second = yield* deploy;
            expect(second.namespaces).toEqual(first.namespaces);
            const upgraded = yield* ready(second.url, 2);
            expect(upgraded.id).toBe(original.id);
            expect(upgraded.rows).toEqual([
              { value: "seed" },
              { value: "user-data" },
              { value: "migration-two" },
            ]);
            const third = yield* deploy;
            // Worker and Durable Object versions can propagate independently.
            expect(yield* ready(third.url, 2)).toEqual(upgraded);
            yield* stack.destroy();
          }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 240_000 },
      );
    },
  );
}
