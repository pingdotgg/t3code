import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import Stack from "./fixtures/issue-zerossl-stack.ts";
import { ZONE_NAME } from "./fixtures/shared.ts";

/**
 * Runtime issuance from inside a deployed Worker: the account bound by
 * `ACME.IssueCertificate`, DNS-01 through `Cloudflare.DNS.WriteDns`.
 *
 * The CA is ZeroSSL (production). Let's Encrypt staging returned TLS errors
 * from Workers during bring-up, so this runs only with
 * `ACME_TEST_ZEROSSL=1` and `ZERO_SSL_KEY`; `IssueCertificate.local.test.ts`
 * covers the same Worker against staging from local workerd.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), ACME.providers()),
});

const enabled =
  process.env.ACME_TEST_ZEROSSL === "1" &&
  (process.env.ZERO_SSL_KEY !== undefined ||
    process.env.ZEROSSL_ACCESS_KEY !== undefined);

// No `beforeAll.skipIf`: deploy only when enabled, else hand the (skipped)
// test an empty handle.
const stack = beforeAll(
  enabled ? deploy(Stack) : Effect.succeed({ url: "" } as { url: string }),
);
afterAll.skipIf(!enabled || !!process.env.NO_DESTROY)(destroy(Stack));

const NAME = `alchemy-acme-worker.${ZONE_NAME}`;

test.skipIf(!enabled)(
  "a Worker issues a certificate at runtime through the bound account",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // The first requests ride out workers.dev propagation.
    // A fresh workers.dev hostname answers 404 for a few seconds.
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
    expect(text, `status ${response.status}: ${text.slice(0, 2000)}`).toMatch(
      /^\{/,
    );
    const body = JSON.parse(text) as {
      issuer?: string;
      notAfter?: string;
      dnsNames?: string[];
      hasKey?: boolean;
      chainLength?: number;
      error?: string;
    };
    expect(body.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(body.issuer).toContain("ZeroSSL");
    expect(body.dnsNames).toEqual([NAME]);
    expect(body.hasKey).toBe(true);
    expect(body.chainLength).toBeGreaterThan(1);
    const now = yield* Effect.sync(() => Date.now());
    expect(Date.parse(body.notAfter!)).toBeGreaterThan(now);
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
