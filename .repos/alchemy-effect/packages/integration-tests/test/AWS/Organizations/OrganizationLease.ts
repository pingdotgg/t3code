import { flociServices } from "@alchemy.run/aws/Local/FlociServices";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * Process-wide lease on the account's single AWS Organization.
 *
 * Suites that read or mutate the organization take a `shared` lease; a suite
 * that creates and deletes the organization itself takes the `exclusive`
 * lease, which waits until every shared holder has released.
 *
 * Under `ALCHEMY_TEST_DEV=1` (Floci) the first shared holder ensures an
 * organization exists and the last one removes what this module provisioned:
 * its named OU and member account, and the organization only if this module
 * created it. Against real AWS the lease only schedules; it never creates or
 * deletes anything, and env-supplied values always win.
 */

// Shared holders take 1 permit; the exclusive holder takes all of them.
const PERMITS = 1024;
const lease = Semaphore.makeUnsafe(PERMITS);
// Writer preference: a waiting exclusive holder blocks new shared holders.
const turnstile = Semaphore.makeUnsafe(1);
// Serializes the holder count with fixture provisioning and teardown.
const fixtureLock = Semaphore.makeUnsafe(1);

export const emulator = process.env.ALCHEMY_TEST_DEV === "1";

/** Whether the delegated-administrator lifecycle has a member account. */
export const canProvideDelegatedAdminAccount =
  !!process.env.AWS_ORG_DELEGATED_ADMIN_ACCOUNT_ID ||
  (emulator && !!process.env.AWS_ORG_MANAGEMENT_ACCOUNT);

const FIXTURE_NAME = "alchemy-test-org-lease";
const FIXTURE_MEMBER_EMAIL = `${FIXTURE_NAME}@example.com`;

let holders = 0;
// `ready`: the organization is ensured; `touched`: reclaim on last release.
let ready = false;
let touched = false;
let createdOrganization = false;

const unredact = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined || typeof value === "string" ? value : Redacted.value(value);

const describeOrganization = organizations.describeOrganization({}).pipe(
  Effect.map((response) => response.Organization),
  Effect.catchTag("AWSOrganizationsNotInUseException", () => Effect.succeed(undefined)),
);

const ensureOrganization = Effect.gen(function* () {
  if ((yield* describeOrganization) !== undefined) return;
  yield* organizations.createOrganization({ FeatureSet: "ALL" }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        createdOrganization = true;
      }),
    ),
    Effect.catchTag("AlreadyInOrganizationException", () => Effect.void),
  );
});

const findRootId = organizations.listRoots({}).pipe(
  Effect.map((response) => response.Roots?.[0]?.Id),
  Effect.catchTag("AWSOrganizationsNotInUseException", () => Effect.succeed(undefined)),
);

const findFixtureOu = (rootId: string) =>
  organizations.listOrganizationalUnitsForParent.pages({ ParentId: rootId }).pipe(
    Stream.runCollect,
    Effect.map((pages) =>
      Array.from(pages)
        .flatMap((page) => page.OrganizationalUnits ?? [])
        .find((unit) => unit.Name === FIXTURE_NAME),
    ),
  );

const ensureFixtureOu = Effect.gen(function* () {
  const rootId = yield* findRootId;
  if (rootId === undefined) {
    return yield* Effect.fail(new Error("the emulator has no organization"));
  }
  const unit =
    (yield* findFixtureOu(rootId)) ??
    (yield* organizations.createOrganizationalUnit({ ParentId: rootId, Name: FIXTURE_NAME }).pipe(
      Effect.map((response) => response.OrganizationalUnit),
      Effect.catchTag("DuplicateOrganizationalUnitException", () => findFixtureOu(rootId)),
    ));
  if (unit?.Arn === undefined) {
    return yield* Effect.fail(new Error(`could not resolve OU ${FIXTURE_NAME}`));
  }
  return unit.Arn;
});

const findFixtureMember = organizations.listAccounts.pages({}).pipe(
  Stream.runCollect,
  Effect.map((pages) =>
    Array.from(pages)
      .flatMap((page) => page.Accounts ?? [])
      .find((account) => unredact(account.Email) === FIXTURE_MEMBER_EMAIL),
  ),
  Effect.catchTag("AWSOrganizationsNotInUseException", () => Effect.succeed(undefined)),
);

const ensureFixtureMember = Effect.gen(function* () {
  const existing = yield* findFixtureMember;
  if (existing?.Id !== undefined) return existing.Id;
  const created = yield* organizations.createAccount({
    AccountName: FIXTURE_NAME,
    Email: FIXTURE_MEMBER_EMAIL,
  });
  const requestId = created.CreateAccountStatus?.Id;
  if (requestId === undefined) {
    return yield* Effect.fail(new Error("CreateAccount returned no request id"));
  }
  const status = yield* organizations
    .describeCreateAccountStatus({ CreateAccountRequestId: requestId })
    .pipe(
      Effect.map((response) => response.CreateAccountStatus),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status): boolean => status?.State !== "IN_PROGRESS",
        times: 15,
      }),
    );
  if (status?.State !== "SUCCEEDED" || status.AccountId === undefined) {
    return yield* Effect.fail(
      new Error(
        `member account creation ended ${status?.State ?? "without status"} (${status?.FailureReason ?? "no reason"})`,
      ),
    );
  }
  return status.AccountId;
});

/** Removes the fixture's named OU and member, and the org if it created it. */
const reclaimFixture = Effect.gen(function* () {
  const member = yield* findFixtureMember;
  if (member?.Id !== undefined) {
    yield* organizations
      .removeAccountFromOrganization({ AccountId: member.Id })
      .pipe(Effect.catchTag("AccountNotFoundException", () => Effect.void));
  }
  const rootId = yield* findRootId;
  const unit = rootId === undefined ? undefined : yield* findFixtureOu(rootId);
  if (unit?.Id !== undefined) {
    yield* organizations
      .deleteOrganizationalUnit({ OrganizationalUnitId: unit.Id })
      .pipe(Effect.catchTag("OrganizationalUnitNotFoundException", () => Effect.void));
  }
  if (createdOrganization) {
    yield* organizations
      .deleteOrganization({})
      .pipe(Effect.catchTag("AWSOrganizationsNotInUseException", () => Effect.void));
    createdOrganization = false;
  }
});

// Pins every fixture call to the emulator, independent of the caller's context.
const onEmulator = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(flociServices()));

const requireShared = Effect.suspend(() =>
  holders > 0
    ? Effect.void
    : Effect.fail(
        new Error('the organization fixture requires OrganizationLease.make(..., "shared")'),
      ),
);

/** OU for the Control Tower lifecycles: `AWS_TEST_CONTROLTOWER_OU`, else the emulator fixture OU. */
export const controlTowerOuArn = Effect.suspend(() => {
  const fromEnv = process.env.AWS_TEST_CONTROLTOWER_OU;
  if (fromEnv) return Effect.succeed(fromEnv);
  if (!emulator) {
    return Effect.fail(new Error("AWS_TEST_CONTROLTOWER_OU is required"));
  }
  return requireShared.pipe(
    Effect.andThen(fixtureLock.withPermits(1)(onEmulator(ensureFixtureOu))),
  );
});

/** Member account: `AWS_ORG_DELEGATED_ADMIN_ACCOUNT_ID`, else the emulator fixture member. */
export const delegatedAdminAccountId = Effect.suspend(() => {
  const fromEnv = process.env.AWS_ORG_DELEGATED_ADMIN_ACCOUNT_ID;
  if (fromEnv) return Effect.succeed(fromEnv);
  if (!emulator) {
    return Effect.fail(new Error("AWS_ORG_DELEGATED_ADMIN_ACCOUNT_ID is required"));
  }
  return requireShared.pipe(
    Effect.andThen(fixtureLock.withPermits(1)(onEmulator(ensureFixtureMember))),
  );
});

const makeShared = () => {
  let held = false;
  let joined = false;
  const release = Effect.suspend(() => {
    if (!held) return Effect.void;
    held = false;
    return fixtureLock
      .withPermits(1)(
        Effect.suspend(() => {
          if (!joined) return Effect.void;
          joined = false;
          holders -= 1;
          if (holders > 0 || !touched) return Effect.void;
          ready = false;
          touched = false;
          return onEmulator(reclaimFixture);
        }),
      )
      .pipe(Effect.ensuring(lease.release(1)));
  });
  const acquire = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* restore(turnstile.withPermits(1)(lease.take(1)));
      held = true;
      yield* Effect.addFinalizer(() =>
        release.pipe(
          Effect.catchCause((cause) => Effect.logError("organization lease release failed", cause)),
        ),
      );
      yield* fixtureLock.withPermits(1)(
        Effect.suspend(() => {
          holders += 1;
          joined = true;
          if (!emulator || ready) return Effect.void;
          touched = true;
          return restore(onEmulator(ensureOrganization)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                ready = true;
              }),
            ),
          );
        }),
      );
    }),
  );
  return { acquire, release };
};

const makeExclusive = () => {
  let held = false;
  const release = Effect.suspend(() => {
    if (!held) return Effect.void;
    held = false;
    return lease.release(PERMITS).pipe(Effect.asVoid);
  });
  const acquire = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* restore(turnstile.withPermits(1)(lease.take(PERMITS)));
      held = true;
      yield* Effect.addFinalizer(() => release);
    }),
  );
  return { acquire, release };
};

/**
 * `Test.make` adapter that holds the organization lease for the whole file.
 * The release hook registers before the file's own `afterAll` hooks, so those
 * must not own organization resources; a scope finalizer backs it up.
 */
export const make = <ROut = any>(
  options: Test.MakeOptions<ROut>,
  mode: "shared" | "exclusive",
): Test.TestApi => {
  const api = Test.make(options);
  const handle = mode === "shared" ? makeShared() : makeExclusive();
  // Waiting is scheduling across the whole run, not a cloud operation.
  api.beforeAll(handle.acquire, { timeout: 3_600_000 });
  api.afterAll(handle.release, { timeout: 120_000 });
  return api;
};
