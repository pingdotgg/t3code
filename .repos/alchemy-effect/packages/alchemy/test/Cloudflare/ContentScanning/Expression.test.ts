import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as contentScanning from "@distilled.cloud/cloudflare/content-scanning";
import { describe, expect } from "alchemy-test";
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

// Custom scan expressions require WAF Content Scanning (an Enterprise paid
// add-on) to be enabled on the zone. On the testing account's zone every
// payload call fails with "File Upload Scan not enabled", surfaced as the
// typed `ContentScanningNotEnabled` error. The full lifecycle test below is
// gated behind an entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_CONTENT_SCANNING_ZONE_ID;

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

// Ride out eventual-consistency 403 blips on the test's own out-of-band
// calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const listExpressions = (zoneId: string) =>
  contentScanning.listPayloads({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
    Effect.map((r) => r.result),
  );

// Both cases enable the same zone-level content-scanning singleton as a prerequisite; run them serially so they don't fight over that singleton under the global concurrent test config.
describe.sequential("Expression", () => {
  test.provider(
    "surfaces the typed ContentScanningNotEnabled error when scanning is disabled",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // The standard testing zone has Content Scanning disabled (and lacks
        // the add-on entirely) — payload calls must fail with the typed tag.
        const error = yield* contentScanning.listPayloads({ zoneId }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
        expect(error._tag).toEqual("ContentScanningNotEnabled");

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  // Requires WAF Content Scanning (Enterprise paid add-on) on the zone — without it payload
  // calls fail with the typed ContentScanningNotEnabled. Unlock with CLOUDFLARE_TEST_CONTENT_SCANNING_ZONE_ID=<zone id>.
  test.provider.skipIf(!entitledZoneId)(
    "creates a custom expression, replaces on payload change, destroys cleanly",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = entitledZoneId!;

        yield* stack.destroy();

        const firstPayload =
          'lookup_json_string(http.request.body.raw, "file")';
        const secondPayload =
          'lookup_json_string(http.request.body.raw, "document")';

        // Scanning must be enabled for payload calls; the expression depends
        // on the singleton through its zoneId output.
        const first = yield* stack.deploy(
          Effect.gen(function* () {
            const scanning = yield* Cloudflare.ContentScanning.ContentScanning(
              "UploadScanning",
              {
                zoneId,
              },
            );
            return yield* Cloudflare.ContentScanning.Expression("ScanField", {
              zoneId: scanning.zoneId,
              payload: firstPayload,
            });
          }),
        );

        expect(first.zoneId).toEqual(zoneId);
        expect(first.payload).toEqual(firstPayload);
        expect(first.expressionId).not.toEqual("");

        // Out-of-band verification via the distilled API.
        const live = yield* listExpressions(zoneId);
        expect(live.some((e) => e.id === first.expressionId)).toBe(true);

        // Changing the payload is a replacement — there is no update
        // endpoint, so a new expression is created and the old one deleted.
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const scanning = yield* Cloudflare.ContentScanning.ContentScanning(
              "UploadScanning",
              {
                zoneId,
              },
            );
            return yield* Cloudflare.ContentScanning.Expression("ScanField", {
              zoneId: scanning.zoneId,
              payload: secondPayload,
            });
          }),
        );

        expect(replaced.payload).toEqual(secondPayload);
        expect(replaced.expressionId).not.toEqual(first.expressionId);

        const afterReplace = yield* listExpressions(zoneId);
        expect(afterReplace.some((e) => e.id === replaced.expressionId)).toBe(
          true,
        );
        expect(afterReplace.some((e) => e.id === first.expressionId)).toBe(
          false,
        );

        yield* stack.destroy();

        // The expression is gone; the singleton was restored to its
        // pre-management status by its own destroy.
        const status = yield* contentScanning.getContentScanning({ zoneId });
        if (status.value === "enabled") {
          // Zone was already enabled before the test — expressions must
          // still be cleaned up.
          const remaining = yield* listExpressions(zoneId);
          expect(remaining.some((e) => e.id === replaced.expressionId)).toBe(
            false,
          );
        }
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // list() fans out over every zone and skips zones without Content Scanning
  // (typed ContentScanningNotEnabled/Forbidden) or deleted zones (InvalidRoute).
  // The standing test zone has scanning disabled, so this returns a well-typed
  // array (empty for un-entitled zones) without throwing — proving the
  // pagination + typed-skip wiring end-to-end.
  test.provider(
    "list returns a well-typed array across all zones",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const provider = yield* Provider.findProvider(
          Cloudflare.ContentScanning.Expression,
        );
        const all = yield* provider.list();

        expect(Array.isArray(all)).toBe(true);
        for (const item of all) {
          expect(typeof item.zoneId).toBe("string");
          expect(typeof item.payload).toBe("string");
          expect(typeof item.expressionId).toBe("string");
        }

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Requires WAF Content Scanning (Enterprise paid add-on) on the zone — without
  // it payload calls fail with the typed ContentScanningNotEnabled. Unlock with
  // CLOUDFLARE_TEST_CONTENT_SCANNING_ZONE_ID=<zone id>.
  test.provider.skipIf(!entitledZoneId)(
    "list enumerates the deployed expression",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = entitledZoneId!;

        yield* stack.destroy();

        const payload = 'lookup_json_string(http.request.body.raw, "file")';

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const scanning = yield* Cloudflare.ContentScanning.ContentScanning(
              "UploadScanning",
              { zoneId },
            );
            return yield* Cloudflare.ContentScanning.Expression("ListField", {
              zoneId: scanning.zoneId,
              payload,
            });
          }),
        );

        const provider = yield* Provider.findProvider(
          Cloudflare.ContentScanning.Expression,
        );
        const all = yield* provider.list();

        const found = all.find((e) => e.expressionId === deployed.expressionId);
        expect(found).toBeDefined();
        expect(found?.zoneId).toEqual(zoneId);
        expect(found?.payload).toEqual(payload);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
