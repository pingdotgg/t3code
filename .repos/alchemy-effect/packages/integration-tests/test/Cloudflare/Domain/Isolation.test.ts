import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { getWorkerTags } from "../Utils/Worker.ts";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import DuplicateWorker from "./fixtures/duplicate-worker.ts";
import Stack from "./fixtures/isolation-stack.ts";
import TwiceWorker from "./fixtures/twice-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** An isolation route answered with something other than 200. */
class IsolationRequestFailed extends Data.TaggedError("IsolationRequestFailed")<{
  readonly status: number;
}> {}

/** Call a route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeader("connection", "close"),
    ),
  ).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new IsolationRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.json),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

test(
  "two models with the same definitions in one Worker keep separate data",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const id = `a-${yield* Effect.sync(() => crypto.randomUUID())}`;

    yield* call(base, "POST", `/Billing/open/${id}/sam`);
    yield* call(base, "POST", `/Audit/open/${id}/alex`);

    // each model's aggregate holds only its own command
    expect(yield* call(base, "GET", `/Billing/state/${id}`)).toEqual({ owner: "sam" });
    expect(yield* call(base, "GET", `/Audit/state/${id}`)).toEqual({ owner: "alex" });

    // each model's view hears only its own aggregate's events
    const owners = (model: string, owner: string) =>
      call(base, "GET", `/${model}/owners/${id}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (state) => (state as { owner?: string } | null)?.owner === owner,
          times: 30,
        }),
      );
    expect(yield* owners("Billing", "sam")).toEqual({ owner: "sam" });
    expect(yield* owners("Audit", "alex")).toEqual({ owner: "alex" });
  }),
  { timeout: 180_000 },
);

test(
  "two models running the same saga in one Worker keep separate runs",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const key = `s-${yield* Effect.sync(() => crypto.randomUUID())}`;

    // the same key in both models: two runs, each with its own input
    expect(yield* call(base, "POST", `/saga/Sales/${key}/sam`)).toEqual({ owner: "sam" });
    expect(yield* call(base, "POST", `/saga/Support/${key}/alex`)).toEqual({ owner: "alex" });
  }),
  { timeout: 180_000 },
);

test(
  "a Worker hosting models records the Domain version it was deployed with",
  Effect.gen(function* () {
    const { workerName } = yield* stack;
    const { accountId } = yield* yield* CloudflareEnvironment;
    expect(
      (yield* getWorkerTags(workerName, accountId)).filter((tag) =>
        tag.startsWith("alchemy:domain:"),
      ),
    ).toEqual(["alchemy:domain:v0"]);
  }).pipe(Effect.provide(CloudflareApiLive()), Effect.scoped),
  { timeout: 60_000 },
);

/**
 * Model names are unique per Worker, even when each model's Layer builds its
 * own platform: two different models named alike would share classes.
 */
test.provider(
  "two different models with one name in a Worker fail; one model hosted twice shares its data",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();
      const duplicate = yield* scratch
        .deploy(
          Effect.gen(function* () {
            return { worker: yield* DuplicateWorker };
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(duplicate)).toBe(true);
      expect(String(duplicate)).toContain("Model Billing is hosted twice on one platform");

      const { worker } = yield* scratch.deploy(
        Effect.gen(function* () {
          return { worker: yield* TwiceWorker };
        }),
      );
      const base = worker.url!.replace(/\/+$/, "");
      yield* call(base, "POST", "/open/a-1/sam");
      expect(yield* call(base, "GET", "/state/a-1")).toEqual({ owner: "sam" });

      yield* scratch.destroy();
    }),
  { timeout: 300_000 },
);
