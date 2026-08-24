import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ride out fresh-token 403 blips on out-of-band calls.
const retryForbidden = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
) =>
  eff.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const getAcl = (accountId: string, aclId: string) =>
  retryForbidden(dns.getZoneTransferAcl({ accountId, aclId }));

// A deleted ACL surfaces as the typed `AclNotFound` (HTTP 404) — poll
// until the GET reports it gone.
const expectGone = (accountId: string, aclId: string) =>
  getAcl(accountId, aclId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "AclNotDeleted" } as const)),
    Effect.catchTag("AclNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "AclNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update in place, and delete a zone transfer ACL",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferAcl("TestAcl", {
          name: "alchemy-dnszt-acl-test",
          // Cloudflare normalizes the range to its network address —
          // use one that is already normalized for stable diffs.
          ipRange: "192.0.2.48/28",
        }),
      );
      expect(created.aclId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.name).toEqual("alchemy-dnszt-acl-test");
      expect(created.ipRange).toEqual("192.0.2.48/28");

      // Out-of-band verify via the SDK.
      const live = yield* getAcl(accountId, created.aclId);
      expect(live.name).toEqual("alchemy-dnszt-acl-test");
      expect(live.ipRange).toEqual("192.0.2.48/28");

      // Update both mutable fields in place — same physical ACL.
      const updated = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferAcl("TestAcl", {
          name: "alchemy-dnszt-acl-test-renamed",
          ipRange: "198.51.100.0/28",
        }),
      );
      expect(updated.aclId).toEqual(created.aclId);
      expect(updated.name).toEqual("alchemy-dnszt-acl-test-renamed");
      expect(updated.ipRange).toEqual("198.51.100.0/28");

      const liveUpdated = yield* getAcl(accountId, created.aclId);
      expect(liveUpdated.name).toEqual("alchemy-dnszt-acl-test-renamed");
      expect(liveUpdated.ipRange).toEqual("198.51.100.0/28");

      yield* stack.destroy();
      yield* expectGone(accountId, created.aclId);

      // Re-running destroy is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "generates a deterministic name when none is provided",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferAcl("DefaultNameAcl", {
          ipRange: "203.0.113.0/28",
        }),
      );
      expect(created.name).toBeDefined();
      expect(created.name.length).toBeGreaterThan(0);
      expect(created.ipRange).toEqual("203.0.113.0/28");

      yield* stack.destroy();
      yield* expectGone(accountId, created.aclId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed zone transfer ACLs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferAcl("ListAcl", {
          name: "alchemy-dnszt-acl-list",
          ipRange: "192.0.2.64/28",
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.DNS.ZoneTransferAcl,
      );
      const all = yield* provider.list();

      // Exhaustively-paginated result contains the deployed ACL, in the
      // exact `read` Attributes shape.
      const found = all.find((a) => a.aclId === deployed.aclId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(deployed.accountId);
      expect(found?.name).toEqual("alchemy-dnszt-acl-list");
      expect(found?.ipRange).toEqual("192.0.2.64/28");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
