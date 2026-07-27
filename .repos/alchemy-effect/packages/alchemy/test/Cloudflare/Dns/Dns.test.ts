import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Core from "@/Test/Core.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
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
    const { accountId } = yield* yield* CloudflareEnvironment;
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

    // Deterministic record name — the same on every run (never
    // Date.now()/random). The fixture's /dns route deletes any leftover
    // record with this name before creating, so a crashed run self-heals
    // instead of leaking records into the zone.
    const name = `alchemy-dns-test-crud.${zoneName}`;

    const client = yield* HttpClient.HttpClient;
    const res = yield* client
      .get(`${effectUrl}/dns?name=${encodeURIComponent(name)}`)
      .pipe(
        // A cold-starting or briefly-unhealthy edge returns 5xx — often a
        // Cloudflare HTML error page, NOT the worker's structured JSON, so we
        // must never try to parse it. Treat any non-200 as transient and ride
        // it out: this covers both cold start and eventual-consistency blips
        // in the scoped API-token propagation the worker depends on.
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
        ),
        // Cap exponential backoff at 3s so retries stay bounded.
        Effect.retry({
          schedule: Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("3 seconds"),
          ]),
          times: 20,
        }),
      );

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
