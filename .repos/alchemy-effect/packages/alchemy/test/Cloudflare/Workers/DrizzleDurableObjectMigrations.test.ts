import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import DrizzleDurableObjectWorker from "./fixtures/drizzle-do/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
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
  "DrizzleDurableObjectMigrationsStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
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
  "DO runs drizzle migrations at init and serves drizzle queries",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    // A fresh instance name per run so the migrated table starts empty
    // even when the stack is kept alive between runs (NO_DESTROY).
    const instance = crypto.randomUUID();

    // Marker-anchored readiness: a freshly-enabled workers.dev hostname can
    // serve Cloudflare's placeholder page with a 200 before the deployed
    // Worker propagates, so gate on the route's JSON body, not the status.
    const addUser = (name: string) =>
      client.post(`${url}/users?do=${instance}&name=${name}`).pipe(
        Effect.flatMap((res) => res.text),
        Effect.flatMap((body) =>
          body.includes(`"ok":true`)
            ? Effect.succeed((JSON.parse(body) as { id: number }).id)
            : Effect.fail(new Error(`Worker not ready: ${body.slice(0, 200)}`)),
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
    const missing = yield* client.get(`${url}/missing-table?do=${instance}`);
    expect(missing.status).toBe(200);
    const caught = (yield* missing.json) as { result: string };
    expect(caught.result).toMatch(
      /^caught:(SqlError|EffectDrizzleQueryError)$/,
    );
  }),
  { timeout: 120_000 },
);
