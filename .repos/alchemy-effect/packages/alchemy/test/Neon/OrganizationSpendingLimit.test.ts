import { adopt, stripUnowned, Unowned } from "@/AdoptPolicy.ts";
import {
  OrganizationSpendingLimit,
  organizationSpendingLimitSnapshot,
  validateOrganizationSpendingLimit,
} from "@/Neon/OrganizationSpendingLimit.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: providers() });

const context = {
  id: "Alert",
  fqn: "Alert",
  instanceId: "alert-validation",
  oldBindings: [],
  newBindings: [],
};

test(
  "spending alerts require positive integer cents and an organization identity",
  Effect.gen(function* () {
    for (const spendingLimitCents of [
      0,
      -1,
      1.5,
      Infinity,
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        Result.isFailure(
          yield* validateOrganizationSpendingLimit({
            orgId: "org-dedicated-fixture",
            spendingLimitCents,
          }).pipe(Effect.result),
        ),
      ).toBe(true);
    }
    expect(
      Result.isFailure(
        yield* validateOrganizationSpendingLimit({
          orgId: "",
          spendingLimitCents: 100,
        }).pipe(Effect.result),
      ),
    ).toBe(true);
    yield* validateOrganizationSpendingLimit({
      orgId: "org-dedicated-fixture",
      spendingLimitCents: 100,
    });
  }),
  {
    tags: ["provider:neon", "provider:neon:organizationspendinglimit", "live"],
  },
);

test.provider(
  "spending organization changes fail before replacing the existing policy",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationSpendingLimit.Provider;
      const olds = { orgId: "org-old", spendingLimitCents: 100 };
      expect(
        yield* provider.diff!({
          ...context,
          olds,
          news: { orgId: "org-new", spendingLimitCents: 100 },
          output: undefined,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("InvalidOrganizationSpendingLimit", () =>
            Effect.succeed(true),
          ),
        ),
      ).toBe(true);
      for (const news of [
        Output.literal(olds),
        Effect.succeed(olds),
        { ...olds, orgId: Output.literal("org-new") },
      ]) {
        expect(
          yield* provider.diff!({
            ...context,
            olds,
            news,
            output: undefined,
          }),
        ).toBeUndefined();
      }
      expect(
        yield* provider.diff!({
          ...context,
          olds,
          news: { ...olds, spendingLimitCents: Output.literal(200) },
          output: undefined,
        }),
      ).toBeUndefined();
    }).pipe(
      Effect.provideService(
        SDK.Credentials,
        Effect.die("Unexpected Neon request in a no-I/O guard test"),
      ),
    ),
  {
    tags: ["provider:neon", "provider:neon:organizationspendinglimit", "live"],
  },
);

test.provider(
  "spending reconciliation rejects a cached identity from another organization before I/O",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationSpendingLimit.Provider;
      expect(
        yield* provider
          .reconcile({
            ...context,
            bindings: [],
            session: {
              emit: () => Effect.void,
              done: () => Effect.void,
              note: () => Effect.void,
            },
            olds: undefined,
            news: { orgId: "org-new", spendingLimitCents: 100 },
            output: {
              orgId: "org-old",
              spendingLimitCents: 200,
              initialSpendingLimitCents: 200,
              managedSpendingLimitCents: 200,
            },
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidOrganizationSpendingLimit", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
    }).pipe(
      Effect.provideService(
        SDK.Credentials,
        Effect.die("Unexpected Neon request in a no-I/O guard test"),
      ),
    ),
  {
    tags: ["provider:neon", "provider:neon:organizationspendinglimit", "live"],
  },
);

test(
  "spending snapshots capture null without adoption and retain the baseline across interrupted writes",
  Effect.sync(() => {
    for (const baseline of [null, 400]) {
      const snapshot = organizationSpendingLimitSnapshot(
        "org-fixture",
        baseline,
      );
      expect(Unowned.is(snapshot)).toBe(baseline !== null);
      expect(snapshot.initialSpendingLimitCents).toBe(baseline);
      expect(snapshot.managedSpendingLimitCents).toBe(baseline);
      const refreshed = organizationSpendingLimitSnapshot(
        "org-fixture",
        100,
        stripUnowned(snapshot),
      );
      expect(Unowned.is(refreshed)).toBe(false);
      expect(refreshed.spendingLimitCents).toBe(100);
      expect(refreshed.initialSpendingLimitCents).toBe(baseline);
      expect(refreshed.managedSpendingLimitCents).toBe(baseline);
      const disappeared = organizationSpendingLimitSnapshot(
        "org-fixture",
        null,
        refreshed,
      );
      expect(disappeared.initialSpendingLimitCents).toBe(baseline);
    }
  }),
  {
    tags: ["provider:neon", "provider:neon:organizationspendinglimit", "live"],
  },
);

test.provider(
  "spending reconciliation refuses missing baseline snapshots before I/O even with adoption enabled",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationSpendingLimit.Provider;
      const incomplete = organizationSpendingLimitSnapshot("org-fixture", null);
      yield* Effect.sync(() =>
        Reflect.deleteProperty(incomplete, "initialSpendingLimitCents"),
      );
      for (const output of [undefined, incomplete]) {
        expect(
          yield* provider
            .reconcile({
              ...context,
              bindings: [],
              session: {
                emit: () => Effect.void,
                done: () => Effect.void,
                note: () => Effect.void,
              },
              olds: undefined,
              news: { orgId: "org-fixture", spendingLimitCents: 100 },
              output,
            })
            .pipe(
              adopt(true),
              Effect.as(false),
              Effect.catchTag("InvalidOrganizationSpendingLimit", () =>
                Effect.succeed(true),
              ),
            ),
        ).toBe(true);
      }
    }).pipe(
      Effect.provideService(
        SDK.Credentials,
        Effect.die("Unexpected Neon request in a no-I/O guard test"),
      ),
    ),
  {
    tags: ["provider:neon", "provider:neon:organizationspendinglimit", "live"],
  },
);

const orgId = process.env.NEON_GOVERNANCE_TEST_ORG_ID;
const threshold = Number(process.env.NEON_GOVERNANCE_TEST_SPENDING_LIMIT_CENTS);
const enabled =
  !!orgId &&
  process.env.NEON_GOVERNANCE_TEST_SPENDING === "1" &&
  Number.isSafeInteger(threshold) &&
  threshold > 0 &&
  threshold < Number.MAX_SAFE_INTEGER - 100;

test.provider.skipIf(!enabled)(
  "dedicated spending fixture preserves adopted baseline and removes only managed new alerts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const organization = orgId!;
      const request = { org_id: organization };
      const original = (yield* SDK.getOrganizationSpendingLimit(request))
        .spending_limit_cents;
      const application = (value: number, takeOwnership = false) =>
        OrganizationSpendingLimit("Alert", {
          orgId: organization,
          spendingLimitCents: value,
        }).pipe(adopt(takeOwnership));

      if (original === null) {
        const planned = yield* stack.plan(application(threshold));
        expect(planned.resources.Alert.state?.attr).toMatchObject({
          orgId: organization,
          spendingLimitCents: null,
          initialSpendingLimitCents: null,
          managedSpendingLimitCents: null,
        });
        expect(
          (yield* SDK.getOrganizationSpendingLimit(request))
            .spending_limit_cents,
        ).toBeNull();
        const created = yield* stack.deploy(application(threshold));
        expect(created.initialSpendingLimitCents).toBeNull();
        expect(
          (yield* SDK.getOrganizationSpendingLimit(request))
            .spending_limit_cents,
        ).toBe(threshold);
        yield* stack.deploy(application(threshold + 1));
        yield* SDK.setOrganizationSpendingLimit({
          ...request,
          spending_limit_cents: threshold + 2,
        });
        expect(
          Result.isFailure(yield* stack.destroy().pipe(Effect.result)),
        ).toBe(true);
        expect(
          (yield* SDK.getOrganizationSpendingLimit(request))
            .spending_limit_cents,
        ).toBe(threshold + 2);
        yield* SDK.setOrganizationSpendingLimit({
          ...request,
          spending_limit_cents: threshold + 1,
        });
        yield* stack.destroy();
        expect(
          (yield* SDK.getOrganizationSpendingLimit(request))
            .spending_limit_cents,
        ).toBeNull();
      }

      const baseline = original ?? threshold + 100;
      if (original === null)
        yield* SDK.setOrganizationSpendingLimit({
          ...request,
          spending_limit_cents: baseline,
        });
      expect(
        Result.isFailure(
          yield* stack.plan(application(threshold)).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        (yield* SDK.getOrganizationSpendingLimit(request)).spending_limit_cents,
      ).toBe(baseline);
      const adopted = yield* stack.deploy(application(threshold, true));
      expect(adopted.initialSpendingLimitCents).toBe(baseline);
      expect(
        (yield* SDK.getOrganizationSpendingLimit(request)).spending_limit_cents,
      ).toBe(threshold);
      const updated = yield* stack.deploy(application(threshold + 1));
      expect(updated.initialSpendingLimitCents).toBe(baseline);
      yield* stack.destroy();
      expect(
        (yield* SDK.getOrganizationSpendingLimit(request)).spending_limit_cents,
      ).toBe(baseline);
      if (original === null)
        yield* SDK.deleteOrganizationSpendingLimit(request);
      expect(
        (yield* SDK.getOrganizationSpendingLimit(request)).spending_limit_cents,
      ).toBe(original);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:organizationspendinglimit", "live"],
    timeout: 120_000,
    exclusive: true,
  },
);
