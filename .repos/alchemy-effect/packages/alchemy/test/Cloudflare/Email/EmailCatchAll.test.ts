import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

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
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// each email-routing operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCatchAll = (zoneId: string) =>
  emailRouting.getRuleCatchAll({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the zone to a known baseline so each run starts from the same
// cloud state regardless of what a previous (possibly interrupted) run left
// behind: Email Routing enabled, catch-all back at the Cloudflare default
// (disabled, drop, no name).
const setBaseline = (zoneId: string) =>
  emailRouting.enableEmailRouting({ zoneId, body: {} }).pipe(
    Effect.andThen(
      emailRouting.putRuleCatchAll({
        zoneId,
        matchers: [{ type: "all" }],
        actions: [{ type: "drop" }],
        enabled: false,
        name: "",
      }),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("EmailCatchAll", () => {
  test.provider(
    "configures the catch-all rule and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        const catchAll = yield* stack.deploy(
          Effect.gen(function* () {
            const routing = yield* Cloudflare.Email.Routing("Routing", {
              zone: zoneName,
            });
            return yield* Cloudflare.Email.CatchAll("CatchAll", {
              zone: { zoneId: routing.zoneId },
              name: "alchemy catch-all",
              actions: [{ type: "drop" }],
            });
          }),
        );

        expect(catchAll.zoneId).toEqual(zoneId);
        expect(catchAll.ruleId).not.toEqual("");
        expect(catchAll.name).toEqual("alchemy catch-all");
        expect(catchAll.enabled).toEqual(true);
        expect(catchAll.actions).toEqual([{ type: "drop" }]);
        // The pre-management state was captured for restore-on-destroy.
        expect(catchAll.initialEnabled).toEqual(false);
        expect(catchAll.initialName).toEqual("");
        expect(catchAll.initialActions).toEqual([{ type: "drop" }]);

        // Out-of-band verification against the live API.
        const live = yield* getCatchAll(zoneId);
        expect(live.enabled).toEqual(true);
        expect(live.name).toEqual("alchemy catch-all");
        expect(live.actions).toEqual([{ type: "drop" }]);

        yield* stack.destroy();

        // Destroy restored the state the catch-all rule had before we
        // managed it. (The rule itself always exists — it is a singleton.)
        const restored = yield* getCatchAll(zoneId);
        expect(restored.enabled).toEqual(false);
        expect(restored.name ?? "").toEqual("");
        expect(restored.actions).toEqual([{ type: "drop" }]);
      }).pipe(logLevel),
  );

  test.provider(
    "updates the catch-all rule in place and keeps the captured baseline",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        const deployCatchAll = (props: {
          name: string;
          enabled?: boolean;
          actions: Cloudflare.Email.Action[];
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const routing = yield* Cloudflare.Email.Routing("Routing", {
                zone: zoneName,
              });
              return yield* Cloudflare.Email.CatchAll("CatchAll", {
                zone: { zoneId: routing.zoneId },
                ...props,
              });
            }),
          );

        const initial = yield* deployCatchAll({
          name: "alchemy update test",
          actions: [{ type: "drop" }],
        });

        expect(initial.enabled).toEqual(true);
        expect(initial.initialEnabled).toEqual(false);
        const ruleId = initial.ruleId;

        const updated = yield* deployCatchAll({
          name: "alchemy update test v2",
          enabled: false,
          actions: [{ type: "drop" }],
        });

        // Same singleton updated in place; the captured baseline survives
        // the update so destroy still restores the pre-management state.
        expect(updated.ruleId).toEqual(ruleId);
        expect(updated.zoneId).toEqual(zoneId);
        expect(updated.name).toEqual("alchemy update test v2");
        expect(updated.enabled).toEqual(false);
        expect(updated.initialEnabled).toEqual(false);
        expect(updated.initialName).toEqual("");

        const live = yield* getCatchAll(zoneId);
        expect(live.enabled).toEqual(false);
        expect(live.name).toEqual("alchemy update test v2");

        yield* stack.destroy();

        const restored = yield* getCatchAll(zoneId);
        expect(restored.enabled).toEqual(false);
        expect(restored.name ?? "").toEqual("");
        expect(restored.actions).toEqual([{ type: "drop" }]);
      }).pipe(logLevel),
  );

  test.provider(
    "recovers a half-created catch-all whose creating-state lost Output-valued props (#736)",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);
        // Safety net: normalize the zone singleton back to the Cloudflare
        // default even if the test dies mid-way.
        yield* Effect.addFinalizer(() =>
          setBaseline(zoneId).pipe(Effect.ignore),
        );

        const deployCatchAll = () =>
          stack.deploy(
            Effect.gen(function* () {
              const routing = yield* Cloudflare.Email.Routing("Routing", {
                zone: zoneName,
              });
              return yield* Cloudflare.Email.CatchAll("CatchAll", {
                // Output-valued zone reference — the #736 shape.
                zone: { zoneId: routing.zoneId },
                name: "alchemy recovery test",
                actions: [{ type: "drop" }],
              });
            }),
          );

        const created = yield* deployCatchAll();
        expect(created.zoneId).toEqual(zoneId);
        expect(created.ruleId).not.toEqual("");

        // Rewrite the persisted row into the wedged shape an interrupted
        // deploy leaves behind: `creating`, no attributes, and the
        // Output-valued `zone` prop lost in the round-trip.
        const state = yield* yield* State;
        const stage = "test"; // scratch stacks default to the "test" stage
        const fqns = yield* state.list({ stack: stack.name, stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state
            .get({ stack: stack.name, stage, fqn })
            .pipe(Effect.map((row) => ({ fqn, row }))),
        );
        const wedged = rows.find(
          (r): r is { fqn: string; row: ResourceState } =>
            isResourceState(r.row) &&
            r.row.resourceType === "Cloudflare.Email.CatchAll",
        );
        if (!wedged) {
          return yield* Effect.die(
            new Error(
              "no Cloudflare.Email.CatchAll state row found after deploy",
            ),
          );
        }
        yield* state.set({
          stack: stack.name,
          stage,
          fqn: wedged.fqn,
          value: {
            ...wedged.row,
            status: "creating",
            attr: undefined,
            props: { ...wedged.row.props, zone: undefined },
          },
        });

        // Before the fix `read` crashed resolving `olds.zone === undefined`
        // (TypeError reading `name` of undefined inside `resolve`). After
        // the fix it reports "not found" and reconcile converges on the
        // same zone singleton — same rule, no duplicate.
        const recovered = yield* deployCatchAll();
        expect(recovered.zoneId).toEqual(zoneId);
        expect(recovered.ruleId).toEqual(created.ruleId);
        expect(recovered.name).toEqual("alchemy recovery test");
        expect(recovered.enabled).toEqual(true);
        expect(recovered.actions).toEqual([{ type: "drop" }]);

        // Out-of-band verification against the live API.
        const live = yield* getCatchAll(zoneId);
        expect(live.enabled).toEqual(true);
        expect(live.name).toEqual("alchemy recovery test");

        yield* stack.destroy();
        // The recovery re-adopted the singleton with the managed state as
        // its restore baseline, so destroy restores that state — normalize
        // the zone back to the Cloudflare default for subsequent tests.
        yield* setBaseline(zoneId);
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone catch-all rule, so `list()` enumerates every zone
  // via `listAllZones` and reads the singleton in each (skipping zones without
  // Email Routing enabled). Ensure Email Routing is enabled on the standing
  // test zone, then assert the result is non-empty, well-typed, and contains
  // the test zone.
  test.provider(
    "list enumerates the catch-all rule across all zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Email Routing must be enabled for the test zone's catch-all to be
        // visible to `list()`; normalize to a known baseline.
        yield* setBaseline(zoneId);

        const provider = yield* Provider.findProvider(
          Cloudflare.Email.CatchAll,
        );
        const all = yield* provider.list();

        expect(all.length).toBeGreaterThan(0);
        const row = all.find((r) => r.zoneId === zoneId);
        expect(row).toBeDefined();
        expect(row!.ruleId).not.toEqual("");
        expect(typeof row!.enabled).toBe("boolean");
        expect(Array.isArray(row!.actions)).toBe(true);

        yield* stack.destroy();
      }).pipe(logLevel),
  );
});
