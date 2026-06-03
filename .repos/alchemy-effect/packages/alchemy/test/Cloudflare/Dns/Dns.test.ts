import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Core from "@/Test/Core.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Resolve the test zone id via the SDK. `withProviders` supplies the Cloudflare
// credentials + account id the lookup needs inside a plain test body.
const resolveZoneId = Core.withProviders(
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name: zoneName });
    return zone?.id;
  }),
  { providers: Cloudflare.providers() },
  "DnsTestStack",
);

test(
  "deployed worker drives the full DNS record CRUD surface via DnsReadWrite",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    expect(effectUrl).toBeTypeOf("string");

    const zoneId = yield* resolveZoneId;
    expect(zoneId, `zone "${zoneName}" not found in account`).toBeTypeOf(
      "string",
    );

    // Unique per run so repeated runs never collide on record name.
    const name = `alchemy-dns-test-${Math.random()
      .toString(36)
      .slice(2, 10)}.${zoneName}`;

    const client = yield* HttpClient.HttpClient;
    const res = yield* client
      .get(`${effectUrl}/dns?name=${encodeURIComponent(name)}`)
      .pipe(
        // Retry only while the worker is still cold-starting (not yet live).
        // Once it responds 200 or 500 the handler ran, so stop and inspect.
        Effect.flatMap((res) =>
          res.status === 200 || res.status === 500
            ? Effect.succeed(res)
            : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 15,
        }),
      );

    if (res.status !== 200) {
      const err = yield* res.json;
      throw new Error(`DNS worker failed: ${JSON.stringify(err)}`);
    }

    const body = (yield* res.json) as {
      id: string;
      getName: string;
      count: number;
      updatedId: string;
      deleted: boolean;
    };
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.getName).toBe(name);
    expect(body.count).toBeGreaterThan(0);
    expect(body.updatedId).toBe(body.id);
    expect(body.deleted).toBe(true);
  }).pipe(logLevel),
  { timeout: 180_000 },
);
