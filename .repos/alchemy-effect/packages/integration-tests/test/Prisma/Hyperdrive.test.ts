import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Prisma from "@alchemy.run/prisma";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import PrismaHyperdriveWorker from "./fixtures/hyperdrive-worker.ts";

const providers = Layer.merge(Cloudflare.providers(), Prisma.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
});

const Stack = Alchemy.Stack(
  "PrismaHyperdriveStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* PrismaHyperdriveWorker;
    return { url: worker.url.as<string>() };
  }),
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

const fetchReady = (req: Effect.Effect<any, any, any>) =>
  req.pipe(
    Effect.flatMap((res: any) =>
      res.status >= 200 && res.status < 300
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body: string) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e: unknown): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(20)]),
    }),
  ) as Effect.Effect<HttpClientResponse, never, HttpClient.HttpClient>;

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 600_000,
});

test(
  "queries Prisma Postgres from a Worker through Hyperdrive",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const insert = yield* fetchReady(
      HttpClient.execute(
        HttpClientRequest.post(`${url}/widgets`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ id: 1, name: "anvil" }),
        ),
      ),
    );
    expect(insert.status).toBe(200);

    const read = yield* fetchReady(HttpClient.get(`${url}/widgets`));
    const body = (yield* read.json) as {
      widgets: Array<{ id: number; name: string }>;
    };
    expect(body.widgets).toEqual(expect.arrayContaining([{ id: 1, name: "anvil" }]));
  }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "provider:prisma",
      "provider:prisma:connection",
      "provider:prisma:project",
      "live",
    ],
    timeout: 300_000,
  },
);
