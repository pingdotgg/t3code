import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as organizations from "@distilled.cloud/cloudflare/organizations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Organizations are entitlement-gated (closed rollout for tenant /
// enterprise customers). On the standard testing account every
// `/organizations` call fails with the typed `Forbidden` error
// (HTTP 403, Cloudflare code 10000 "Authentication error"). The full
// lifecycle test below is gated behind an explicit opt-in env flag for
// entitled accounts; the probe test always runs and pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_ORGANIZATIONS;

// Probe once per suite: either the account can list organizations
// (entitled) or the call fails with the typed `Forbidden` tag.
const probeEntitlement = organizations.listOrganizations({ pageSize: 1 }).pipe(
  Effect.as(true),
  Effect.catchTag("Forbidden", () => Effect.succeed(false)),
);

// Deterministic names — the same on every run (never Date.now()/random).
const ORG_NAME_CRUD = "alchemy-org-crud";
const ORG_NAME_CRUD_RENAMED = "alchemy-org-crud-renamed";

const PROFILE = {
  businessName: "Alchemy Test Co",
  businessEmail: "test@alchemy.run",
  businessPhone: "+1-555-0100",
  businessAddress: "1 Test Way, Springfield",
  externalMetadata: "alchemy:test",
} as const;

test.provider(
  "unentitled accounts surface the typed Forbidden error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const canList = yield* probeEntitlement;
      if (canList) {
        // Entitled account — nothing to assert here; the lifecycle test
        // covers the real behavior.
        yield* Effect.logInfo(
          "account is organizations-entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* organizations
        .listOrganizations({ pageSize: 1 })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");

      const createError = yield* organizations
        .createOrganization({ name: ORG_NAME_CRUD })
        .pipe(Effect.flip);
      expect(createError._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test — ungated probe. `list()` enumerates every
// organization reachable by the credentials. On an unentitled account the
// `/organizations` collection rejects with the typed `Forbidden` tag, which
// the provider's `list()` deliberately tolerates (returning `[]`) so that
// account-wide enumeration / `nuke` never blows up on a non-tenant account;
// the raw-op probe test above already pins the typed tag. On an entitled
// account it returns a well-typed `Attributes[]`.
test.provider(
  "list either enumerates organizations or tolerates the unentitled account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Organization.Organization,
      );

      const canList = yield* probeEntitlement;
      if (canList) {
        const all = yield* provider.list();
        // Well-typed Attributes array; entitled accounts may have zero or
        // more organizations, so only assert the shape.
        expect(Array.isArray(all)).toBe(true);
        for (const org of all) {
          expect(typeof org.organizationId).toBe("string");
          expect(typeof org.name).toBe("string");
        }
      } else {
        // Unentitled: list() swallows the typed Forbidden and reports an
        // empty collection (nuke-safe), rather than propagating.
        const all = yield* provider.list();
        expect(all).toEqual([]);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Gated live enumeration: on an entitled account, a deployed organization
// must appear in the exhaustively-paginated `list()` result.
test.provider.skipIf(!entitled)(
  "list enumerates the deployed organization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Organization.Organization("ListOrg", {
            name: ORG_NAME_CRUD,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Organization.Organization,
      );
      const all = yield* provider.list();

      expect(
        all.some((o) => o.organizationId === deployed.organizationId),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Poll until the organization is gone after destroy. Cloudflare answers
// GET for a missing org with the typed `OrganizationNotFound` (404).
const expectGone = (organizationId: string) =>
  organizations.getOrganization({ organizationId }).pipe(
    Effect.asSome,
    Effect.catchTag("OrganizationNotFound", () => Effect.succeedNone),
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: (org) => org._tag === "None",
      times: 8,
    }),
    Effect.map((org) => expect(org._tag).toEqual("None")),
  );

test.provider.skipIf(!entitled)(
  "create, verify out-of-band, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with a business profile.
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Organization.Organization("Org", {
            name: ORG_NAME_CRUD,
            profile: PROFILE,
          });
        }),
      );

      expect(v1.organizationId).toBeTruthy();
      expect(v1.name).toEqual(ORG_NAME_CRUD);
      expect(v1.createTime).toBeTruthy();
      expect(v1.profile).toEqual(PROFILE);

      // Out-of-band verification via the distilled API.
      const live = yield* organizations.getOrganization({
        organizationId: v1.organizationId,
      });
      expect(live.name).toEqual(ORG_NAME_CRUD);
      expect(live.profile).toEqual(PROFILE);

      // In-place update — rename and change the profile email. Same
      // organization (no replacement).
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Organization.Organization("Org", {
            name: ORG_NAME_CRUD_RENAMED,
            profile: { ...PROFILE, businessEmail: "ops@alchemy.run" },
          });
        }),
      );

      expect(v2.organizationId).toEqual(v1.organizationId);
      expect(v2.createTime).toEqual(v1.createTime);
      expect(v2.name).toEqual(ORG_NAME_CRUD_RENAMED);
      expect(v2.profile?.businessEmail).toEqual("ops@alchemy.run");

      const updated = yield* organizations.getOrganization({
        organizationId: v2.organizationId,
      });
      expect(updated.name).toEqual(ORG_NAME_CRUD_RENAMED);
      expect(updated.profile?.businessEmail).toEqual("ops@alchemy.run");

      // No-op deploy — same desired state, same identity.
      const v3 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Organization.Organization("Org", {
            name: ORG_NAME_CRUD_RENAMED,
            profile: { ...PROFILE, businessEmail: "ops@alchemy.run" },
          });
        }),
      );
      expect(v3.organizationId).toEqual(v1.organizationId);

      yield* stack.destroy();

      yield* expectGone(v1.organizationId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
