import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as aiSecurity from "@distilled.cloud/cloudflare/ai-security";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// AI Security for Apps (Firewall for AI) is entitlement-gated — on the
// standard testing account every call fails with "not entitled to access
// this resource" (code 13101), surfaced as the typed `AiSecurityNotEntitled`
// error. The full lifecycle test below is gated behind an entitled zone id
// supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_AI_SECURITY_ZONE_ID;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getTopics = (zoneId: string) =>
  aiSecurity.getCustomTopic({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the list to a known baseline so each run starts from the same
// cloud state regardless of what a previous run left behind.
const setBaseline = (
  zoneId: string,
  topics: { label: string; topic: string }[],
) =>
  aiSecurity.putCustomTopic({ zoneId, topics }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed AiSecurityNotEntitled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The testing account lacks the AI Security entitlement — both the
      // read and the write must fail with the typed entitlement tag.
      const readError = yield* getTopics(zoneId).pipe(Effect.flip);
      expect(readError._tag).toEqual("AiSecurityNotEntitled");

      const writeError = yield* setBaseline(zoneId, []).pipe(Effect.flip);
      expect(writeError._tag).toEqual("AiSecurityNotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped singleton): there is no account-wide
// API for this per-zone list, so `list()` enumerates every zone via
// `listAllZones` and reads the singleton in each, skipping zones that reject
// with the typed `AiSecurityNotEntitled` / `ZoneNotAuthorized` / `Forbidden`
// tags. On the unentitled testing account every zone is skipped, so the
// result is an empty array — the assertion is that `list()` resolves to an
// array (proving the typed skip path) rather than throwing. Presence of the
// standing test zone is asserted only on an entitled account (env-gated).
test.provider("list enumerates the custom topics across all zones", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Cloudflare.AI.CustomTopics);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    if (entitledZoneId) {
      expect(all.some((t) => t.zoneId === entitledZoneId)).toBe(true);
    }

    // `stack` is unused (the singleton always exists on every entitled zone),
    // but keep the destroy bookends so the harness state stays clean.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!entitledZoneId)(
  "sets topics, updates the list in place, and restores on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;

      yield* stack.destroy();
      // Known baseline: no custom topics.
      yield* setBaseline(zoneId, []);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AI.CustomTopics("Topics", {
            zoneId,
            topics: [
              {
                label: "billing",
                topic: "Questions about invoices and payments",
              },
              { label: "abuse", topic: "Harassment or abusive language" },
            ],
          });
        }),
      );

      expect(created.zoneId).toEqual(zoneId);
      expect(created.topics).toHaveLength(2);
      // The pre-management list was captured for restore-on-destroy.
      expect(created.initialTopics).toEqual([]);

      // Out-of-band verification via the distilled API.
      const live = yield* getTopics(zoneId);
      expect(live.topics ?? []).toHaveLength(2);

      // Update in place — the PUT replaces the whole list.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AI.CustomTopics("Topics", {
            zoneId,
            topics: [
              { label: "support", topic: "Questions about product support" },
            ],
          });
        }),
      );
      expect(updated.topics).toHaveLength(1);
      expect(updated.topics[0]?.label).toEqual("support");
      expect(updated.initialTopics).toEqual([]);

      const replacedList = yield* getTopics(zoneId);
      expect(replacedList.topics ?? []).toHaveLength(1);

      yield* stack.destroy();

      // Destroy restored the (empty) list the zone had before we managed it.
      const restored = yield* getTopics(zoneId);
      expect(restored.topics ?? []).toEqual([]);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
