import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Turso from "@alchemy.run/turso";
import { organization } from "@alchemy.run/turso/Credentials";
import * as turso from "@distilled.cloud/turso/turso";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Turso.providers() });

// Invites and members need a team organization on a paid plan. The Starter
// plan rejects them with `BadRequest`:
//   "organization <slug> can't invite users because plan starter doesn't support it"
// Set TURSO_TEST_TEAM=1 (and TURSO_TEST_MEMBER=<username>) on an entitled org.
const team = !!process.env.TURSO_TEST_TEAM;
const memberUsername = process.env.TURSO_TEST_MEMBER;
// Toggling overages changes billing; never run it by default.
const overages = !!process.env.TURSO_TEST_ORG_SETTINGS;

const INVITE_EMAIL = "alchemy-turso-invite@example.com";

test.provider.skipIf(team)(
  "invites on the Starter plan fail with a typed BadRequest",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const error = yield* turso
        .inviteOrganizationMemberV2({ organizationSlug: org, email: INVITE_EMAIL, role: "member" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("BadRequest");
      yield* stack.destroy();
    }),
  { tags: ["provider:turso", "provider:turso:organizationinvite", "live"], timeout: 60_000 },
);

test.provider.skipIf(!team)(
  "invite, change role, and withdraw an invite",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const pending = () =>
        turso
          .listOrganizationInvitesV2({ organizationSlug: org })
          .pipe(Effect.map(({ invites }) => (invites ?? []).find((i) => i.email === INVITE_EMAIL)));

      yield* stack.deploy(Turso.OrganizationInvite("Invite", { email: INVITE_EMAIL }));
      expect((yield* pending())?.role).toBe("member");

      yield* stack.deploy(
        Turso.OrganizationInvite("Invite", { email: INVITE_EMAIL, role: "viewer" }),
      );
      expect((yield* pending())?.role).toBe("viewer");

      yield* stack.destroy();
      expect(yield* pending()).toBeUndefined();
    }),
  { tags: ["provider:turso", "provider:turso:organizationinvite", "live"], timeout: 60_000 },
);

test.provider.skipIf(!team || !memberUsername)(
  "add a member, change their role, and remove them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const username = memberUsername!;
      const role = () =>
        turso.getOrganizationMember({ organizationSlug: org, username }).pipe(
          Effect.map(({ member }) => member?.role),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );

      yield* stack.deploy(Turso.OrganizationMember("Member", { username, role: "viewer" }));
      expect(yield* role()).toBe("viewer");
      yield* stack.deploy(Turso.OrganizationMember("Member", { username, role: "member" }));
      expect(yield* role()).toBe("member");

      yield* stack.destroy();
      expect(yield* role()).toBeUndefined();
    }),
  { tags: ["provider:turso", "provider:turso:organizationmember", "live"], timeout: 60_000 },
);

test.provider(
  "restoreEnabled is applied and restored on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const observe = turso
        .getOrganization({ organizationSlug: org })
        .pipe(Effect.map(({ organization }) => organization?.restore_enabled ?? false));
      const original = yield* observe;

      const settings = yield* stack.deploy(
        Turso.OrganizationSettings("Org", { restoreEnabled: !original }),
      );
      expect(settings.original.restoreEnabled).toBe(original);
      expect(settings.restoreEnabled).toBe(!original);
      // Organization reads can briefly lag a write; poll until it shows.
      const settle = (expected: boolean) =>
        observe.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (value) => value === expected,
            times: 15,
          }),
        );
      expect(yield* settle(!original)).toBe(!original);

      yield* stack.destroy();
      expect(yield* settle(original)).toBe(original);
    }),
  // An account-wide setting: run with no other Turso test in flight.
  {
    tags: ["provider:turso", "provider:turso:organizationsettings", "live"],
    timeout: 90_000,
    exclusive: true,
  },
);

test.provider.skipIf(!overages)(
  "organization settings are applied and restored on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const observe = turso
        .getOrganization({ organizationSlug: org })
        .pipe(Effect.map(({ organization }) => organization?.overages ?? false));
      const original = yield* observe;

      const settings = yield* stack.deploy(
        Turso.OrganizationSettings("Org", { overages: !original }),
      );
      expect(settings.original.overages).toBe(original);
      expect(yield* observe).toBe(!original);

      yield* stack.destroy();
      expect(yield* observe).toBe(original);
    }),
  { tags: ["provider:turso", "provider:turso:organizationsettings", "live"], timeout: 60_000 },
);
