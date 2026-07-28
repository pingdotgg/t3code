import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic invite addresses we own — invites stay `pending`, which is
// fine; deleting the member cancels the invite. Each test owns a distinct
// address: the suites run concurrently against one shared account, so a
// shared email would let one test's destroy/cleanup cancel another's invite
// mid-flight (a `MemberNotFound` race).
const crudEmail = "sam+alchemy-test-member-crud@alchemy.run";
const replaceEmail = "sam+alchemy-test-member-replace@alchemy.run";
const replacedEmail = "sam+alchemy-test-member-replaced@alchemy.run";
const healEmail = "sam+alchemy-test-member-heal@alchemy.run";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const getMember = (accountId: string, memberId: string) =>
  accounts
    .getMember({ accountId, memberId })
    .pipe(Effect.retry(forbiddenRetry));

const expectGone = (accountId: string, memberId: string) =>
  getMember(accountId, memberId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "MemberNotDeleted" } as const)),
    // A missing member surfaces as `MemberNotFound` (Cloudflare error
    // code 1003) — that's the success condition here.
    Effect.catchTag("MemberNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "MemberNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Remove any membership left behind by a previous crashed run so the test
// account stays clean and create paths start from a known baseline.
const cleanupEmail = (accountId: string, email: string) =>
  accounts.listMembers.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.retry(forbiddenRetry),
    Effect.flatMap((chunk) => {
      const match = Array.from(chunk).find(
        (member) => member.email?.toLowerCase() === email.toLowerCase(),
      );
      return match?.id != null
        ? accounts
            .deleteMember({ accountId, memberId: match.id })
            .pipe(Effect.catchTag("MemberNotFound", () => Effect.void))
        : Effect.void;
    }),
  );

// Pick two deterministic non-super-admin roles for the account: sorted by
// name so every run selects the same pair.
const pickTwoRoles = (accountId: string) =>
  accounts.listRoles.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.retry(forbiddenRetry),
    Effect.map((chunk) => {
      const roles = Array.from(chunk)
        .filter((role) => !role.name.startsWith("Super Administrator"))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(roles.length).toBeGreaterThanOrEqual(2);
      return [roles[0]!, roles[1]!] as const;
    }),
  );

// Read-only: enumerating account members sends no invites. The account
// owner is always an accepted member, so `list()` must return a non-empty,
// well-typed `Attributes[]` containing at least one accepted membership.
test.provider("list enumerates the account members", (_stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    const provider = yield* Provider.findProvider(Cloudflare.Account.Member);
    const all = yield* provider.list().pipe(Effect.retry(forbiddenRetry));

    expect(all.length).toBeGreaterThan(0);
    // Every element is the exact `read` shape, scoped to this account.
    for (const member of all) {
      expect(member.memberId).toBeTruthy();
      expect(member.accountId).toEqual(accountId);
      expect(typeof member.email).toBe("string");
      expect(Array.isArray(member.roles)).toBe(true);
    }
    // The account owner is an accepted member.
    expect(all.some((member) => member.status === "accepted")).toBe(true);
  }).pipe(logLevel),
);

test.provider("create member, update roles in place, delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* cleanupEmail(accountId, crudEmail);

    const [roleA, roleB] = yield* pickTwoRoles(accountId);

    const member = yield* stack.deploy(
      Cloudflare.Account.Member("TestMember", {
        email: crudEmail,
        roles: [roleA.id],
      }),
    );

    expect(member.memberId).toBeTruthy();
    expect(member.accountId).toEqual(accountId);
    expect(member.email.toLowerCase()).toEqual(crudEmail);
    expect(member.status).toEqual("pending");
    expect(member.roles.map((r) => r.id)).toEqual([roleA.id]);

    // Out-of-band verify the invite exists with the assigned role.
    const live = yield* getMember(accountId, member.memberId);
    expect(live.email?.toLowerCase()).toEqual(crudEmail);
    expect((live.roles ?? []).map((r) => r.id)).toEqual([roleA.id]);

    // Swap the role — same email, so the membership is updated in place.
    const updated = yield* stack.deploy(
      Cloudflare.Account.Member("TestMember", {
        email: crudEmail,
        roles: [roleB.id],
      }),
    );
    expect(updated.memberId).toEqual(member.memberId);
    expect(updated.roles.map((r) => r.id)).toEqual([roleB.id]);

    const liveUpdated = yield* getMember(accountId, member.memberId);
    expect((liveUpdated.roles ?? []).map((r) => r.id)).toEqual([roleB.id]);

    // Redeploying identical props is a no-op (same membership).
    const noop = yield* stack.deploy(
      Cloudflare.Account.Member("TestMember", {
        email: crudEmail,
        roles: [roleB.id],
      }),
    );
    expect(noop.memberId).toEqual(member.memberId);

    yield* stack.destroy();
    yield* expectGone(accountId, member.memberId);
  }).pipe(logLevel),
);

test.provider("replaces the member when the email changes", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* cleanupEmail(accountId, replaceEmail);
    yield* cleanupEmail(accountId, replacedEmail);

    const [roleA] = yield* pickTwoRoles(accountId);

    const original = yield* stack.deploy(
      Cloudflare.Account.Member("ReplaceMember", {
        email: replaceEmail,
        roles: [roleA.id],
      }),
    );

    // Changing the email re-invites: a fresh membership id, and the old
    // invite is cancelled by the replacement's delete phase.
    const replaced = yield* stack.deploy(
      Cloudflare.Account.Member("ReplaceMember", {
        email: replacedEmail,
        roles: [roleA.id],
      }),
    );

    expect(replaced.memberId).not.toEqual(original.memberId);
    expect(replaced.email.toLowerCase()).toEqual(replacedEmail);
    yield* expectGone(accountId, original.memberId);

    yield* stack.destroy();
    yield* expectGone(accountId, replaced.memberId);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* cleanupEmail(accountId, healEmail);

    const [roleA, roleB] = yield* pickTwoRoles(accountId);

    const member = yield* stack.deploy(
      Cloudflare.Account.Member("HealMember", {
        email: healEmail,
        roles: [roleA.id],
      }),
    );

    // Cancel the invite out-of-band. A redeploy with identical props is a
    // planner no-op, so change the role to force reconcile — it must
    // observe the member as missing and re-invite instead of failing.
    yield* accounts
      .deleteMember({ accountId, memberId: member.memberId })
      .pipe(Effect.retry(forbiddenRetry));

    const healed = yield* stack.deploy(
      Cloudflare.Account.Member("HealMember", {
        email: healEmail,
        roles: [roleB.id],
      }),
    );

    expect(healed.memberId).not.toEqual(member.memberId);
    expect(healed.roles.map((r) => r.id)).toEqual([roleB.id]);

    const live = yield* getMember(accountId, healed.memberId);
    expect((live.roles ?? []).map((r) => r.id)).toEqual([roleB.id]);

    yield* stack.destroy();
    yield* expectGone(accountId, healed.memberId);
  }).pipe(logLevel),
);
