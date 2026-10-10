import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import Stack from "./fixtures/issue-stack.ts";
import { ZONE_NAME } from "./fixtures/shared.ts";

/**
 * The same runtime issuance as `IssueCertificate.test.ts`, but the Worker
 * runs in local workerd (`alchemy dev`): the bound account and DNS token
 * are real, the CA is Let's Encrypt staging, only the Worker is local.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), ACME.providers()),
  dev: true,
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const NAME = `alchemy-acme-worker-local.${ZONE_NAME}`;

test(
  "a local Worker issues a certificate at runtime through the bound account",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toContain("localhost");
    const client = yield* HttpClient.HttpClient;
    const ok = yield* client.get(`${url}/`).pipe(
      Effect.filterOrFail(
        (r) => r.status === 200,
        (r) => new Error(`not ready: ${r.status}`),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
    );
    expect(ok.status).toBe(200);

    const response = yield* client.get(`${url}/issue?name=${NAME}`);
    const text = yield* response.text;
    yield* Effect.log("ISSUE RESPONSE", { status: response.status, text });
    const body = JSON.parse(text) as {
      issuer?: string;
      dnsNames?: string[];
      hasKey?: boolean;
      error?: string;
    };
    expect(body.error).toBeUndefined();
    expect(body.issuer).toContain("STAGING");
    expect(body.dnsNames).toEqual([NAME]);
    expect(body.hasKey).toBe(true);
  }),
  {
    tags: [
      "provider:acme",
      "provider:acme:account",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "provider:cloudflare:worker",
      "provider:cloudflare:zone",
      "provider:zerossl",
      "live",
    ],
    timeout: 240_000,
  },
);
