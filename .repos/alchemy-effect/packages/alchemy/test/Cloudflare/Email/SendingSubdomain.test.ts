import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emailSending from "@distilled.cloud/cloudflare/email-sending";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test subdomain names. Each test owns a disjoint
// subdomain so reruns and parallel runs never collide, and the same name is
// reused on every run (never derive physical names from Date.now()/random).
const NAME_DEFAULT = `alchemy-sendsub-default.${zoneName}`;
const NAME_REPLACE_A = `alchemy-sendsub-replace-a.${zoneName}`;
const NAME_REPLACE_B = `alchemy-sendsub-replace-b.${zoneName}`;
const NAME_ADOPT = `alchemy-sendsub-adopt.${zoneName}`;
const NAME_LIST = `alchemy-sendsub-list.${zoneName}`;

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

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band verification calls by retrying the typed `Forbidden`
// error (part of each email-sending operation's error union via distilled
// patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const findByName = (zoneId: string, name: string) =>
  emailSending.listSubdomains.items({ zoneId }).pipe(
    Stream.filter((s) => s.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const getSubdomain = (zoneId: string, subdomainId: string) =>
  emailSending.getSubdomain({ zoneId, subdomainId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Delete any subdomain matching `name` — used to purge leftovers from
// interrupted runs so tests start from a clean slate.
const purgeSubdomain = (zoneId: string, name: string) =>
  findByName(zoneId, name).pipe(
    Effect.flatMap((existing) =>
      existing
        ? emailSending
            .deleteSubdomain({ zoneId, subdomainId: existing.tag })
            .pipe(
              Effect.catchTag("SendingSubdomainNotFound", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "Forbidden",
                schedule: forbiddenRetrySchedule,
                times: 8,
              }),
            )
        : Effect.void,
    ),
  );

test.provider("create and destroy a sending subdomain", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeSubdomain(zoneId, NAME_DEFAULT);

    const sending = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Email.SendingSubdomain("Sending", {
          zoneId,
          name: NAME_DEFAULT,
        });
      }),
    );

    expect(sending.subdomainId).toBeDefined();
    expect(sending.zoneId).toEqual(zoneId);
    expect(sending.name).toEqual(NAME_DEFAULT);
    // CF-hosted zone — DNS records are auto-created and validate
    // immediately; the reconciler polls briefly for `enabled`.
    expect(sending.enabled).toEqual(true);
    expect(sending.dkimSelector).toBeDefined();
    expect(sending.returnPathDomain).toContain(NAME_DEFAULT);

    // Out-of-band verification against the live API.
    const live = yield* getSubdomain(zoneId, sending.subdomainId);
    expect(live.tag).toEqual(sending.subdomainId);
    expect(live.name).toEqual(NAME_DEFAULT);

    yield* stack.destroy();

    // Gone after destroy — the typed not-found is the success signal.
    const gone = yield* getSubdomain(zoneId, sending.subdomainId).pipe(
      Effect.map(() => "still-there" as const),
      Effect.catchTag("SendingSubdomainNotFound", () =>
        Effect.succeed("gone" as const),
      ),
    );
    expect(gone).toEqual("gone");

    // Destroy again — delete is idempotent.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("changing the name triggers replacement", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeSubdomain(zoneId, NAME_REPLACE_A);
    yield* purgeSubdomain(zoneId, NAME_REPLACE_B);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Email.SendingSubdomain("ReplaceSending", {
          zoneId,
          name: NAME_REPLACE_A,
        });
      }),
    );

    expect(initial.name).toEqual(NAME_REPLACE_A);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Email.SendingSubdomain("ReplaceSending", {
          zoneId,
          name: NAME_REPLACE_B,
        });
      }),
    );

    // The name is the subdomain's identity — a new physical resource.
    expect(replaced.subdomainId).not.toEqual(initial.subdomainId);
    expect(replaced.name).toEqual(NAME_REPLACE_B);

    // The old subdomain was deleted as part of the replacement.
    const old = yield* findByName(zoneId, NAME_REPLACE_A);
    expect(old).toBeUndefined();

    const live = yield* findByName(zoneId, NAME_REPLACE_B);
    expect(live?.tag).toEqual(replaced.subdomainId);

    yield* stack.destroy();

    const gone = yield* findByName(zoneId, NAME_REPLACE_B);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);

test.provider(
  "adoption — existing subdomain errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeSubdomain(zoneId, NAME_ADOPT);

      // Create the subdomain out-of-band so the stack has no state of its
      // own for it — exactly the "already exists" scenario.
      const pre = yield* emailSending
        .createSubdomain({ zoneId, name: NAME_ADOPT })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(pre.tag).toBeDefined();

      // Without `adopt`: sending subdomains carry no ownership markers, so
      // the engine cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Email.SendingSubdomain("AdoptSending", {
              zoneId,
              name: NAME_ADOPT,
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With adopt(true): the engine takes over the existing subdomain
      // instead of failing.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.SendingSubdomain("AdoptSending", {
            zoneId,
            name: NAME_ADOPT,
          }).pipe(adopt(true));
        }),
      );
      expect(adopted.subdomainId).toEqual(pre.tag);
      expect(adopted.name).toEqual(NAME_ADOPT);

      yield* stack.destroy();

      const gone = yield* findByName(zoneId, NAME_ADOPT);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "list enumerates the deployed sending subdomain",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeSubdomain(zoneId, NAME_LIST);

      const sending = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.SendingSubdomain("ListSending", {
            zoneId,
            name: NAME_LIST,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Email.SendingSubdomain,
      );
      // The scoped token may still be propagating across the edge; ride out
      // the typed Forbidden blips on the enumeration itself.
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
      );

      // The deployed subdomain is present, with the full read Attributes shape.
      const found = all.find((s) => s.subdomainId === sending.subdomainId);
      expect(found).toBeDefined();
      expect(found?.zoneId).toEqual(zoneId);
      expect(found?.name).toEqual(NAME_LIST);

      yield* stack.destroy();

      const gone = yield* findByName(zoneId, NAME_LIST);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );
