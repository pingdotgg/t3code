import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// workers.dev URLs take a few seconds to propagate after first enable.
const getOnce = (url: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    if (response.status === 404) {
      return yield* Effect.fail(new Error("workers.dev not yet propagated"));
    }
    return response;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }));

test(
  "stack outputs reflect the deployed email infrastructure",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.url).toBeString();
    expect(out.zoneId).toBeString();
    expect(out.routingEnabled).toBe(true);
    expect(out.destinationEmail).toBeString();
    expect(out.ruleId).toBeString();
  }),
);

test(
  "worker exposes the configured sender/destination on /healthz",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* getOnce(`${url.replace(/\/+$/, "")}/healthz`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as {
      ok: boolean;
      from: string;
      to: string;
    };
    expect(body.ok).toBe(true);
    expect(body.from).toBeString();
    expect(body.to).toBeString();
  }),
  { timeout: 60_000 },
);

test(
  "worker sends an email via the send_email binding",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    yield* getOnce(baseUrl);

    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/send`).pipe(
        HttpClientRequest.setBody(
          HttpBody.text(
            JSON.stringify({
              subject: `alchemy integ ${Date.now()}`,
              text: "hello from cloudflare-email integ.test.ts",
            }),
            "application/json",
          ),
        ),
      ),
    );
    expect(response.status).toBe(200);
    const body = (yield* response.json) as {
      ok: boolean;
      message?: string;
    };
    if (!body.ok) {
      // Surface the Cloudflare-side error so the failure is debuggable.
      // Most often: "destination address not verified" until a human
      // clicks the link sent by EmailAddress.
      throw new Error(`send_email rejected the message: ${body.message}`);
    }
    expect(body.ok).toBe(true);
  }),
  { timeout: 120_000 },
);
