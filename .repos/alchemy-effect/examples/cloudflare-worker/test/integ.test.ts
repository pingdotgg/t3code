import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";
import { WORKFLOW_SECRET_VALUE } from "../src/NotifyWorkflow.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
  // dev: true,
});

// This stack deploys a Container (Sandbox) whose image build + push can take
// well over the default 120s hook budget, so give deploy/destroy more room.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 600_000,
});

// A fresh `workers.dev` URL transiently 404s/5xxs while the route propagates;
// `HttpClient.execute` resolves on those, so retry until the worker answers.
const { executeWhenReady } = Test;

test(
  "integ",
  Effect.gen(function* () {
    const { url } = yield* stack;

    expect(url).toBeString();
  }),
);

/**
 * Regression guard for https://github.com/alchemy-run/alchemy/pull/172
 *
 * The stack now includes two Workers (`Api` and `SecondaryApi`) that both
 * bind the same `Agent` Durable Object, which in turn binds the `Sandbox`
 * Container. Each `yield* Agent` runs the DO's outer init, calling
 * `Cloudflare.Container(Sandbox)` once per Worker, so the Sandbox
 * ContainerApplication receives two bindings sharing one `namespaceId`.
 *
 * Before the dedupe fix, `getDurableObjects` counted those as two distinct
 * namespaces and the deploy in `beforeAll` died with:
 *
 *   "A Container can only be bound to one Durable Object namespace.
 *    Found 2 namespaces in bindings: <id>, <id>"
 *
 * If the deploy ever starts failing again, the whole suite stops at
 * `beforeAll` — that is the regression signal. This case just asserts the
 * second Worker showed up with a URL so a silent regression that drops the
 * binding still surfaces here.
 */
test(
  "two workers binding the same container deploy without dedup error",
  Effect.gen(function* () {
    const { secondaryApiUrl } = yield* stack;
    expect(secondaryApiUrl).toBeString();
  }),
);

/**
 * Regression guard for https://github.com/alchemy-run/alchemy/pull/71
 *
 * `NotifyWorkflow` accesses `Cloudflare.Workers.WorkerEnvironment` inside its body and
 * performs a KV roundtrip via `env.KV.put` / `env.KV.get`. If the fix from #71
 * is ever reverted, the body Effect loses the `WorkerEnvironment` service and
 * dies with `Service not found: Cloudflare.Workers.WorkerEnvironment` on the
 * first `yield* Cloudflare.Workers.WorkerEnvironment` — the workflow instance never
 * reaches `complete`, and this test times out or surfaces the `errored` status.
 */
test(
  "workflow body can access WorkerEnvironment and exercise env bindings",
  Effect.gen(function* () {
    const { url } = yield* stack;

    interface WorkflowStatus {
      status: string;
      output?: { secret?: string };
      error?: unknown;
    }

    // Start a fresh workflow instance and poll it to a terminal state. A
    // freshly-deployed worker occasionally errors a step while its bindings
    // are still propagating, so this effect FAILS on any non-complete
    // terminal state, letting the outer retry take another swing with a
    // brand-new instance rather than flaking on a transient `errored`.
    const runOnce = Effect.gen(function* () {
      const roomId = `smoke-${Date.now()}`;

      // A freshly-deployed worker transiently 404s (route still propagating)
      // or 5xxs (bindings still settling) on the workflow routes, so retry
      // through the cold-start window instead of asserting `200` on the first
      // hit. Only a non-cold-start status reaches the `expect` below.
      const startResponse = yield* executeWhenReady(
        HttpClientRequest.post(`${url}/workflow/start/${roomId}`),
      );
      expect(startResponse.status).toBe(200);

      const { instanceId } = (yield* startResponse.json) as {
        instanceId: string;
      };
      expect(instanceId).toBeString();

      const client = yield* HttpClient.HttpClient;
      const lastStatus = yield* client
        .get(`${url}/workflow/status/${instanceId}`)
        .pipe(
          // Only decode JSON on a 200; a transient 5xx (HTML error page) while
          // the worker settles is treated as non-terminal so the poll keeps
          // swinging instead of dying on a JSON decode error.
          Effect.flatMap((res) =>
            res.status === 200
              ? (res.json as Effect.Effect<unknown, unknown>).pipe(
                  Effect.map((body) => body as WorkflowStatus),
                )
              : Effect.succeed({ status: "pending" } as WorkflowStatus),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (s) => s.status === "complete" || s.status === "errored",
            times: 30,
          }),
        );

      // Surface a non-complete terminal state as a failure so the outer retry
      // can restart with a fresh instance.
      if (lastStatus.status !== "complete") {
        return yield* Effect.fail(
          new Error(
            `workflow ${lastStatus.status}: ${JSON.stringify(lastStatus.error)}`,
          ),
        );
      }
      return lastStatus;
    });

    const lastStatus = yield* runOnce.pipe(
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
    );

    expect(lastStatus.status).toBe("complete");
    expect(lastStatus.error).toBeFalsy();

    // Prove the `Alchemy.Secret(...)` bound at plantime made it all the
    // way through to the workflow body's runtime read. The workflow body
    // unwraps `Redacted.value(secret)` and embeds it in the returned
    // `processed` payload.
    expect(lastStatus.output?.secret).toBe(Redacted.value(WORKFLOW_SECRET_VALUE));
  }),
  { timeout: 120_000 },
);

/**
 * Queue producer→consumer round-trip via the Effect-style
 * `Cloudflare.Queues.consumeQueueMessages(Queue, handler)` API.
 *
 * Producer: `POST /queue/send` returns `{ sent: { id, text, sentAt } }`
 * after enqueuing a message.
 *
 * Consumer: the worker's queue() handler (registered via subscribe in
 * src/Api.ts) writes the message body to R2 at `/queue/<id>`. The
 * route `GET /queue/result/<id>` reads it back. Cloudflare's queue
 * dispatch is async and best-effort, so we poll for up to 60s.
 */
test(
  "queue producer→consumer round-trip via consumeQueueMessages()",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const text = `hello-${Date.now()}`;
    type Message = { id: string; text: string; sentAt: number };

    const send = Effect.gen(function* () {
      const sendResponse = yield* executeWhenReady(
        HttpClientRequest.post(`${url}/queue/send`).pipe(
          HttpClientRequest.setBody(HttpBody.text(text)),
        ),
      );
      expect(sendResponse.status).toBe(202);
      const { sent } = (yield* sendResponse.json) as { sent: Message };
      expect(sent.id).toBeTypeOf("string");
      return sent;
    });

    const sent: Message[] = [yield* send];

    // First delivery on a freshly created queue+consumer can lag well past
    // the settled steady state (consumer attachment propagates through
    // Cloudflare's queue subsystem asynchronously). Poll for ANY of the
    // messages we sent, re-sending every ~20s in case an early message was
    // published into the propagation window; the consumer persists each
    // message to R2 keyed by its id, so the first one to land wins.
    let polls = 0;
    const findConsumed = Effect.gen(function* () {
      polls++;
      if (polls % 10 === 0 && sent.length < 5) {
        sent.push(yield* send);
      }
      for (const message of sent) {
        const resultResponse = yield* HttpClient.get(
          `${url}/queue/result/${message.id}`,
        );
        if (resultResponse.status === 200) {
          return (yield* resultResponse.json) as Message;
        }
      }
      return undefined;
    });

    const consumed = yield* findConsumed.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (message) => message !== undefined,
        times: 75,
      }),
    );

    expect(consumed).toBeDefined();
    expect(sent.map((message) => message.id)).toContain(consumed!.id);
    expect(consumed!.text).toBe(text);

    // Clean up the consumed R2 entries so afterAll's stack.destroy()
    // can delete the bucket — otherwise Cloudflare rejects the
    // bucket delete with "bucket is not empty".
    yield* Effect.forEach(sent, (message) =>
      HttpClient.execute(
        HttpClientRequest.make("DELETE")(`${url}/queue/result/${message.id}`),
      ),
    );
  }),
  { timeout: 180_000 },
);
