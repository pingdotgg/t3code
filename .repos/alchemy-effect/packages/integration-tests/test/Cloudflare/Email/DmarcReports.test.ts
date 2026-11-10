import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as emailAuth from "@distilled.cloud/cloudflare/email-auth";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

const listDmarcRecords = (zoneId: string) =>
  dns.listRecords.items({ zoneId, name: { exact: `_dmarc.${zoneName}` }, type: "TXT" }).pipe(
    Stream.filter((r) => r.name === `_dmarc.${zoneName}` && r.type === "TXT"),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

describe.sequential(
  "DmarcReports",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:email", "provider:cloudflare:zone", "live"],
  },
  () => {
    test.provider("enables, disables and destroys without deleting DNS records", (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // Capture the zone's pre-test state so the run leaves no residue.
        const before = yield* emailAuth.getDmarcReport({ zoneId });

        const enabled = yield* stack.deploy(
          Cloudflare.Email.DmarcReports("Dmarc", { zone: zoneName }),
        );
        expect(enabled.zoneId).toEqual(zoneId);
        expect(enabled.enabled).toEqual(true);
        expect(enabled.ruaPrefix).toMatch(/^[0-9a-f]{32}$/);

        const live = yield* emailAuth.getDmarcReport({ zoneId });
        expect(live.enabled).toEqual(true);

        // Enabling upserts Cloudflare's RUA address into `_dmarc`.
        const records = yield* listDmarcRecords(zoneId);
        expect(records.some((r) => String(r.content).includes(enabled.ruaPrefix!))).toEqual(true);

        const disabled = yield* stack.deploy(
          Cloudflare.Email.DmarcReports("Dmarc", { zone: zoneName, enabled: false }),
        );
        expect(disabled.enabled).toEqual(false);
        expect((yield* emailAuth.getDmarcReport({ zoneId })).enabled).toEqual(false);

        // Disabling never deletes DNS records.
        const afterDisable = yield* listDmarcRecords(zoneId);
        expect(afterDisable.map((r) => r.id).sort()).toEqual(records.map((r) => r.id).sort());

        // Re-enable so destroy has something to turn off.
        yield* stack.deploy(Cloudflare.Email.DmarcReports("Dmarc", { zone: zoneName }));

        yield* stack.destroy();

        expect((yield* emailAuth.getDmarcReport({ zoneId })).enabled).toEqual(false);
        const afterDestroy = yield* listDmarcRecords(zoneId);
        expect(afterDestroy.map((r) => r.id).sort()).toEqual(records.map((r) => r.id).sort());

        // Restore the captured state.
        if (before.enabled) {
          yield* emailAuth.patchDmarcReport({ zoneId, enabled: true });
        }
      }).pipe(logLevel),
    );
  },
);
