import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { EMAIL_ROUTING_ZONE, emailRoutingScoped } from "./scope.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-stage subdomains, reused on every run.
const subdomainOf = (stage: string, label: string) =>
  `alchemy-routesub-${label}-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.${zoneName}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const retryForbidden = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const routingMx = (zoneId: string, name: string) =>
  retryForbidden(
    dns.listRecords.items({ zoneId, name: { exact: name }, type: "MX" }).pipe(
      Stream.filter((record) => /^route\d+\.mx\.cloudflare\.net\.?$/iu.test(record.content ?? "")),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    ),
  );

// Every record at the name, so a leftover SPF TXT also fails the assertion.
const recordsAt = (zoneId: string, name: string) =>
  retryForbidden(
    dns.listRecords.items({ zoneId, name: { exact: name } }).pipe(
      Stream.map((record) => `${record.type} ${record.content}`),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    ),
  );

describe.skipIf(!emailRoutingScoped)(
  "RoutingSubdomain",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:email", "provider:cloudflare:zone", "live"],
  },
  () => {
    test.provider(
      "create, rename and destroy a routing subdomain, leaving the apex routing",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;
          const nameA = subdomainOf(stack.stage, "a");
          const nameB = subdomainOf(stack.stage, "b");
          yield* stack.destroy();

          // The subdomain needs Email Routing on the zone; capture it to restore.
          const before = yield* retryForbidden(emailRouting.getEmailRouting({ zoneId }));
          if (!before.enabled) yield* retryForbidden(emailRouting.enableEmailRouting({ zoneId }));

          const subdomainProgram = (name: string) =>
            Effect.gen(function* () {
              return yield* Cloudflare.Email.RoutingSubdomain("Inbound", { zoneId, name });
            });
          const deploy = (name: string) => stack.deploy(subdomainProgram(name));

          const subdomain = yield* deploy(nameA);
          expect(subdomain.zoneId).toEqual(zoneId);
          expect(subdomain.name).toEqual(nameA);
          expect(subdomain.mx.length).toBeGreaterThan(0);

          // Out-of-band: the subdomain has Email Routing MX records.
          expect((yield* routingMx(zoneId, nameA)).length).toBeGreaterThan(0);

          // A second deploy with the same props is a no-op; a rename replaces.
          expect((yield* stack.plan(subdomainProgram(nameA))).resources.Inbound?.action).toBe(
            "noop",
          );
          expect((yield* stack.plan(subdomainProgram(nameB))).resources.Inbound?.action).toBe(
            "replace",
          );
          const again = yield* deploy(nameA);
          expect(again.mx).toEqual(subdomain.mx);

          // Renaming replaces it: the new name routes mail, the old one no longer does.
          const renamed = yield* deploy(nameB);
          expect(renamed.name).toEqual(nameB);
          expect((yield* routingMx(zoneId, nameB)).length).toBeGreaterThan(0);
          expect(yield* recordsAt(zoneId, nameA)).toEqual([]);

          yield* stack.destroy();

          // The subdomain's records are gone, and the apex still routes mail.
          expect(yield* recordsAt(zoneId, nameB)).toEqual([]);
          const after = yield* retryForbidden(emailRouting.getEmailRouting({ zoneId }));
          expect(after.enabled).toEqual(true);

          if (!before.enabled) yield* retryForbidden(emailRouting.disableEmailRouting({ zoneId }));
        }).pipe(logLevel),
      { timeout: 120_000, exclusive: EMAIL_ROUTING_ZONE },
    );
  },
);
