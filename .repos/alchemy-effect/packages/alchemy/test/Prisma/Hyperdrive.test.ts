import * as Cloudflare from "@/Cloudflare";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import * as Alchemy from "@/index.ts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import PrismaHyperdriveWorker from "./fixtures/hyperdrive-worker.ts";

const wantsLive = process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS === "true";
const hasLiveCredentials =
  !!process.env.PRISMA_SERVICE_TOKEN?.trim() ||
  !!process.env.PRISMA_API_TOKEN?.trim() ||
  process.env.ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE === "true";
const runLive = wantsLive && hasLiveCredentials;

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
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(20),
      ]),
    }),
  ) as Effect.Effect<HttpClientResponse, never, HttpClient.HttpClient>;

const stack = runLive ? beforeAll(deploy(Stack), { timeout: 600_000 }) : null;
afterAll.skipIf(!runLive || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 600_000,
});

test.skipIf(!runLive)(
  "queries Prisma Postgres from a Worker through Hyperdrive",
  Effect.gen(function* () {
    const { url } = yield* stack!;

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
    expect(body.widgets).toEqual(
      expect.arrayContaining([{ id: 1, name: "anvil" }]),
    );
  }),
  { timeout: 300_000 },
);
