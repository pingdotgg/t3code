import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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

test(
  "integ",
  Effect.gen(function* () {
    const { url } = yield* stack;

    expect(url).toBeString();
  }),
);

/**
 * Regression guard for https://github.com/alchemy-run/alchemy-effect/pull/172
 *
 * The stack now includes two Workers (`Api` and `SecondaryApi`) that both
 * bind the same `Agent` Durable Object, which in turn binds the `Sandbox`
 * Container. Each `yield* Agent` runs the DO's outer init, calling
 * `Cloudflare.Container.bind(Sandbox)` once per Worker, so the Sandbox
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
 * Regression guard for https://github.com/alchemy-run/alchemy-effect/pull/71
 *
 * `NotifyWorkflow` accesses `Cloudflare.WorkerEnvironment` inside its body and
 * performs a KV roundtrip via `env.KV.put` / `env.KV.get`. If the fix from #71
 * is ever reverted, the body Effect loses the `WorkerEnvironment` service and
 * dies with `Service not found: Cloudflare.Workers.WorkerEnvironment` on the
 * first `yield* Cloudflare.WorkerEnvironment` — the workflow instance never
 * reaches `complete`, and this test times out or surfaces the `errored` status.
 */
test(
  "workflow body can access WorkerEnvironment and exercise env bindings",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const roomId = `smoke-${Date.now()}`;

    // Start the workflow instance.
    const startResponse = yield* Effect.tryPromise({
      try: () => fetch(`${url}/workflow/start/${roomId}`, { method: "POST" }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    expect(startResponse.status).toBe(200);

    const { instanceId } = yield* Effect.tryPromise({
      try: () => startResponse.json() as Promise<{ instanceId: string }>,
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    expect(instanceId).toBeString();

    // Poll status until complete / errored / timeout (~60s).
    const deadline = Date.now() + 60_000;
    let lastStatus:
      | { status: string; output?: unknown; error?: unknown }
      | undefined;
    while (Date.now() < deadline) {
      const statusResponse = yield* Effect.tryPromise({
        try: () => fetch(`${url}/workflow/status/${instanceId}`),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      expect(statusResponse.status).toBe(200);
      lastStatus = yield* Effect.tryPromise({
        try: () =>
          statusResponse.json() as Promise<{
            status: string;
            output?: unknown;
            error?: unknown;
          }>,
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      if (lastStatus.status === "complete" || lastStatus.status === "errored") {
        break;
      }
      yield* Effect.sleep("2 seconds");
    }

    // The workflow must have completed — if WorkerEnvironment provision breaks,
    // the body dies on the first yield and the instance never reaches complete.
    expect(lastStatus).toBeDefined();
    expect(lastStatus!.status).toBe("complete");
    expect(lastStatus!.error).toBeFalsy();

    // Prove the `Alchemy.Secret(...)` bound at plantime made it all the
    // way through to the workflow body's runtime read. The workflow body
    // unwraps `Redacted.value(secret)` and embeds it in the returned
    // `processed` payload.
    const output = lastStatus!.output as { secret?: string } | undefined;
    expect(output?.secret).toBe(Redacted.value(WORKFLOW_SECRET_VALUE));
  }),
  { timeout: 120_000 },
);

/**
 * Queue producer→consumer round-trip via the Effect-style
 * `Cloudflare.messages(Queue).subscribe(...)` API.
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
  "queue producer→consumer round-trip via messages().subscribe()",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const text = `hello-${Date.now()}`;

    const sendResponse = yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/queue/send`).pipe(
        HttpClientRequest.setBody(HttpBody.text(text)),
      ),
    );
    expect(sendResponse.status).toBe(202);
    const { sent } = (yield* sendResponse.json) as {
      sent: { id: string; text: string; sentAt: number };
    };
    expect(sent.id).toBeTypeOf("string");

    const deadline = Date.now() + 60_000;
    let consumed: { id: string; text: string; sentAt: number } | undefined;
    while (Date.now() < deadline) {
      const resultResponse = yield* HttpClient.get(
        `${url}/queue/result/${sent.id}`,
      );
      if (resultResponse.status === 200) {
        consumed = (yield* resultResponse.json) as typeof consumed;
        break;
      }
      yield* Effect.sleep("2 seconds");
    }

    expect(consumed).toBeDefined();
    expect(consumed!.id).toBe(sent.id);
    expect(consumed!.text).toBe(text);

    // Clean up the consumed R2 entry so afterAll's stack.destroy()
    // can delete the bucket — otherwise Cloudflare rejects the
    // bucket delete with "bucket is not empty".
    yield* HttpClient.execute(
      HttpClientRequest.make("DELETE")(`${url}/queue/result/${sent.id}`),
    );
  }),
  { timeout: 120_000 },
);
