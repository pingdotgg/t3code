import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Turso from "@alchemy.run/turso";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { BindingDb, TenantGroup } from "./fixtures/resources.ts";
import TursoWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Turso.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "TursoBindingsStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const db = yield* BindingDb;
    const group = yield* TenantGroup;
    const worker = yield* TursoWorker;
    return {
      url: worker.url.as<string>(),
      group: group.name,
      organization: group.organization,
      db: db.name,
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const get = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return yield* res.json;
  });

test(
  "Connect + SQL.LibSQL queries the bound database",
  Effect.gen(function* () {
    const body = (yield* get("/sql")) as { count: number };
    expect(body.count).toBeGreaterThanOrEqual(1);
  }),
  {
    tags: [
      "provider:turso",
      "provider:turso:database",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "SQL.LibSQL transactions roll back on failure",
  Effect.gen(function* () {
    const body = (yield* get("/tx")) as { failed: boolean; before: number; after: number };
    expect(body.failed).toBe(true);
    expect(body.after).toBe(body.before);
  }),
  {
    tags: [
      "provider:turso",
      "provider:turso:database",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "Connect + Drizzle.LibSQL queries the bound database",
  Effect.gen(function* () {
    yield* get("/sql");
    const body = (yield* get("/drizzle")) as { bodies: string[] };
    expect(body.bodies).toContain("from-drizzle");
  }),
  {
    tags: [
      "provider:turso",
      "provider:turso:database",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "Drizzle.LibSQL with relations serves db.query",
  Effect.gen(function* () {
    const body = (yield* get("/relations")) as {
      author: { name: string; posts: Array<{ title: string }> };
    };
    expect(body.author.name).toBe("ada");
    expect(body.author.posts.map((p) => p.title)).toEqual(["engines"]);
  }),
  {
    tags: [
      "provider:turso",
      "provider:turso:database",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "Connect accessors work with @libsql/client directly",
  Effect.gen(function* () {
    const body = (yield* get("/client")) as { seven: number };
    expect(body.seven).toBe(7);
  }),
  {
    tags: [
      "provider:turso",
      "provider:turso:database",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "ManageDatabases creates, queries, lists, and deletes tenant databases",
  Effect.gen(function* () {
    const { group, organization: org } = yield* stack;
    const name = `${group}-t1`.slice(0, 40);
    const body = (yield* get(`/tenant?name=${name}`)) as {
      url: string;
      value: string;
      listed: string[];
      deleted: boolean;
    };
    expect(body.url).toBe(`libsql://${name}-${org}.aws-us-east-1.turso.io`);
    expect(body.value).toBe(name);
    expect(body.listed).toContain(name);
    // `deleted` is the Worker's own Platform API lookup after the delete.
    expect(body.deleted).toBe(true);
  }),
  {
    tags: [
      "provider:turso",
      "provider:turso:database",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);
