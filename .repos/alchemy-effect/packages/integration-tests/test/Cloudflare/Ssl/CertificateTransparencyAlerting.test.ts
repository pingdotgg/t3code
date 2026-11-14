import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
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

// Recipients get a subscribe email when they are added, so the test uses a
// reserved domain.
const recipient = "ct-alerts@example.com";
const secondRecipient = "ct-alerts-2@example.com";

describe.sequential(
  "CertificateTransparencyAlerting",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:ssl", "provider:cloudflare:zone", "live"],
  },
  () => {
    test.provider(
      "enables alerting by default, updates it in place, and restores the zone on destroy",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();

          const original = yield* zones.getCtAlerting({ zoneId });
          const deployAlerting = (props: { enabled?: boolean; emails?: string[] }) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Ssl.CertificateTransparencyAlerting("CtAlerting", {
                  zoneId,
                  ...props,
                });
              }),
            );

          // `enabled` is omitted: the default turns alerting on.
          const created = yield* deployAlerting({ emails: [recipient] });
          expect(created.enabled).toBe(true);
          expect(created.emails).toEqual([recipient]);
          expect(created.initialEnabled).toEqual(original.enabled);

          const live = yield* zones.getCtAlerting({ zoneId });
          expect(live.enabled).toBe(true);
          expect(live.emails ?? []).toEqual([recipient]);

          // Update the recipients in place; the snapshot of the zone's
          // original state must survive the update.
          const updated = yield* deployAlerting({ emails: [recipient, secondRecipient] });
          expect([...updated.emails].sort()).toEqual([recipient, secondRecipient].sort());
          expect(updated.initialEnabled).toEqual(original.enabled);
          expect([...((yield* zones.getCtAlerting({ zoneId })).emails ?? [])].sort()).toEqual(
            [recipient, secondRecipient].sort(),
          );

          // Turn alerting off explicitly.
          const disabled = yield* deployAlerting({
            enabled: false,
            emails: [recipient, secondRecipient],
          });
          expect(disabled.enabled).toBe(false);
          expect((yield* zones.getCtAlerting({ zoneId })).enabled).toBe(false);

          yield* stack.destroy();

          const after = yield* zones.getCtAlerting({ zoneId });
          expect(after.enabled).toEqual(original.enabled);
          expect([...(after.emails ?? [])].sort()).toEqual([...(original.emails ?? [])].sort());
        }).pipe(logLevel),
      { timeout: 240_000 },
    );
  },
);
