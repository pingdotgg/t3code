import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as googleTagGateway from "@distilled.cloud/cloudflare/google-tag-gateway";
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

// Freshly minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403 blips on the test's own
// out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getConfig = (zoneId: string) =>
  googleTagGateway.getConfig({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// A known disabled baseline so each run starts from the same cloud state
// regardless of what a previous (possibly interrupted) run left behind.
const baseline = {
  enabled: false,
  endpoint: "/baseline",
  hideOriginalIp: false,
  measurementId: "G-BASELINE01",
  setUpTag: false,
} as const;

const setBaseline = (zoneId: string) =>
  googleTagGateway.putConfig({ zoneId, ...baseline }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("GoogleTagGateway", () => {
  test.provider(
    "configures the gateway, updates in place, and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        yield* Effect.gen(function* () {
          // Create — enable the gateway with a deterministic config.
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.GoogleTagGateway.GoogleTagGateway(
                "Gtg",
                {
                  zone: { zoneId, name: zoneName },
                  enabled: true,
                  endpoint: "/metrics",
                  measurementId: "G-TEST123456",
                  hideOriginalIp: true,
                  setUpTag: false,
                },
              );
            }),
          );

          expect(created.zoneId).toEqual(zoneId);
          expect(created.enabled).toEqual(true);
          expect(created.endpoint).toEqual("/metrics");
          expect(created.measurementId).toEqual("G-TEST123456");
          expect(created.hideOriginalIp).toEqual(true);
          expect(created.setUpTag).toEqual(false);
          // The pre-management config was captured for restore-on-destroy.
          expect(created.initialConfig).toEqual(baseline);

          // Out-of-band verify the live config.
          const live = yield* getConfig(zoneId);
          expect(live).not.toBeNull();
          expect(live?.enabled).toEqual(true);
          expect(live?.endpoint).toEqual("/metrics");
          expect(live?.hideOriginalIp).toEqual(true);

          // Update in place — same zone, new endpoint and IP setting.
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.GoogleTagGateway.GoogleTagGateway(
                "Gtg",
                {
                  zone: { zoneId, name: zoneName },
                  enabled: true,
                  endpoint: "/collect2",
                  measurementId: "G-TEST123456",
                  hideOriginalIp: false,
                  setUpTag: false,
                },
              );
            }),
          );

          expect(updated.zoneId).toEqual(zoneId);
          expect(updated.endpoint).toEqual("/collect2");
          expect(updated.hideOriginalIp).toEqual(false);
          // Still the same singleton — the captured baseline is retained.
          expect(updated.initialConfig).toEqual(baseline);

          const liveUpdated = yield* getConfig(zoneId);
          expect(liveUpdated?.endpoint).toEqual("/collect2");
          expect(liveUpdated?.hideOriginalIp).toEqual(false);

          // Destroy — the gateway is restored to the pre-management baseline.
          yield* stack.destroy();

          const restored = yield* getConfig(zoneId);
          expect(restored).toEqual(baseline);
        }).pipe(
          // Leave the zone in the disabled baseline even if the test fails.
          Effect.ensuring(setBaseline(zoneId).pipe(Effect.ignore)),
        );
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "no-op redeploy skips the PUT and destroy is idempotent",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        yield* Effect.gen(function* () {
          const program = Effect.gen(function* () {
            return yield* Cloudflare.GoogleTagGateway.GoogleTagGateway(
              "GtgNoop",
              {
                zone: { zoneId, name: zoneName },
                enabled: false,
                endpoint: "/noop",
                measurementId: "GTM-TEST123",
                hideOriginalIp: false,
                setUpTag: false,
              },
            );
          });

          const first = yield* stack.deploy(program);
          expect(first.endpoint).toEqual("/noop");
          expect(first.measurementId).toEqual("GTM-TEST123");
          expect(first.initialConfig).toEqual(baseline);

          // Redeploy with identical props — converges without drift.
          const second = yield* stack.deploy(program);
          expect(second.endpoint).toEqual("/noop");
          expect(second.initialConfig).toEqual(baseline);

          yield* stack.destroy();
          const restored = yield* getConfig(zoneId);
          expect(restored).toEqual(baseline);

          // Destroy again — idempotent.
          yield* stack.destroy();
          const stillRestored = yield* getConfig(zoneId);
          expect(stillRestored).toEqual(baseline);
        }).pipe(Effect.ensuring(setBaseline(zoneId).pipe(Effect.ignore)));
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "recovers a creating-state row whose Output-valued zone prop was lost (#736)",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        yield* Effect.gen(function* () {
          const deployGateway = () =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.GoogleTagGateway.GoogleTagGateway(
                  "GtgWedged",
                  {
                    zone: { zoneId, name: zoneName },
                    enabled: true,
                    endpoint: "/wedged",
                    measurementId: "G-WEDGED0001",
                    hideOriginalIp: true,
                    setUpTag: false,
                  },
                );
              }),
            );

          const created = yield* deployGateway();
          expect(created.zoneId).toEqual(zoneId);

          // Rewrite the persisted row into the wedged shape an interrupted
          // deploy leaves behind: `creating`, no attributes, and the
          // Output-valued `zone` prop lost in the state round-trip (#736).
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
              r.row.resourceType ===
                "Cloudflare.GoogleTagGateway.GoogleTagGateway",
          );
          if (!wedged) {
            return yield* Effect.die(
              new Error("no GoogleTagGateway state row found after deploy"),
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

          // Before the fix this crashed in `read` with
          // `TypeError: undefined is not an object (evaluating 'zone.name')`
          // (resolve(olds.zone) with a lost `zone`). After the fix, read
          // reports "not found" and reconcile converges on the same zone
          // singleton — no drift, same identity.
          const recovered = yield* deployGateway();
          expect(recovered.zoneId).toEqual(created.zoneId);
          expect(recovered.enabled).toEqual(true);
          expect(recovered.endpoint).toEqual("/wedged");
          expect(recovered.measurementId).toEqual("G-WEDGED0001");
          expect(recovered.hideOriginalIp).toEqual(true);

          // The live singleton still matches — converged, not duplicated.
          const live = yield* getConfig(zoneId);
          expect(live?.endpoint).toEqual("/wedged");
          expect(live?.measurementId).toEqual("G-WEDGED0001");

          yield* stack.destroy();
        }).pipe(
          // Leave the zone in the disabled baseline even if the test fails.
          Effect.ensuring(setBaseline(zoneId).pipe(Effect.ignore)),
        );
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Canonical `list()` test (zone-scoped singleton with a `null` baseline):
  // there is no account-wide API for the per-zone config, so `list()`
  // enumerates every zone via `listAllZones` and reads each one, skipping
  // zones that have never configured the feature. Deploy a config on the
  // standing test zone and assert it shows up in the enumeration.
  //
  // SKIP REASON (distilled core schema-decode bug): for a zone that has never
  // configured Google Tag Gateway the API returns `{"result":null,...}`. The
  // distilled core client coerces a null `result` to `{}` before decoding
  // (packages/core/src/client.ts:826 — `responsePath === "result" && nested
  // === null ? {} : nested`). `GetConfigResponse` is `Union([Struct, Null])`,
  // so `{}` matches neither branch and the op fails with an untyped, uncatchable
  //   CloudflareHttpError: {"result":null,"success":true,"errors":[],"messages":[]}
  //   status: 200, statusText: 'Schema decode failed'
  // Because this is a *success-response* decode failure (not an error response),
  // the per-service error-patch system can't convert it to a typed tag — the fix
  // must be in distilled core: only coerce null `result` to `{}` when the output
  // schema does NOT accept null (e.g. `if (!Schema.is(outputSchema)(null)) …`).
  // Until that lands, any account with at least one unconfigured zone breaks
  // enumeration. Run with CLOUDFLARE_TEST_GTG_LIST=1 once distilled is fixed.
  test.provider.skipIf(!process.env.CLOUDFLARE_TEST_GTG_LIST)(
    "list enumerates configured zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        yield* Effect.gen(function* () {
          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.GoogleTagGateway.GoogleTagGateway(
                "GtgList",
                {
                  zone: { zoneId, name: zoneName },
                  enabled: true,
                  endpoint: "/listcfg",
                  measurementId: "G-LIST123456",
                  hideOriginalIp: true,
                  setUpTag: false,
                },
              );
            }),
          );

          const provider = yield* Provider.findProvider(
            Cloudflare.GoogleTagGateway.GoogleTagGateway,
          );
          const all = yield* provider.list();

          // The configured test zone appears with its full Attributes shape.
          const found = all.find((c) => c.zoneId === deployed.zoneId);
          expect(found).toBeDefined();
          expect(found?.endpoint).toEqual("/listcfg");
          expect(found?.measurementId).toEqual("G-LIST123456");

          yield* stack.destroy();
        }).pipe(Effect.ensuring(setBaseline(zoneId).pipe(Effect.ignore)));
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
