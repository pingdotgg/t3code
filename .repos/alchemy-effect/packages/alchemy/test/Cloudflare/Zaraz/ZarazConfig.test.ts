import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import { deepEqual } from "@/Diff";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { stripNullFields, stripUndefinedFields } from "@/Util/data";
import * as zaraz from "@distilled.cloud/cloudflare/zaraz";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneId = process.env.CLOUDFLARE_TEST_ZARAZ_ZONE_ID;
const zoneName =
  process.env.CLOUDFLARE_TEST_ZARAZ_ZONE_NAME ?? "alchemy-test-2.us";

// Zaraz needs no entitlement (available on all plans), but its config is a
// zone-wide singleton these tests mutate in place — they only run against a
// dedicated opt-in zone via CLOUDFLARE_TEST_ZARAZ_ZONE_ID (+ optional _NAME).
// All cases mutate the same zone-wide Zaraz config singleton; run them
// serially so they don't corrupt each other under the global concurrent
// test config.
describe.sequential("Config", () => {
  test.provider.skipIf(!zoneId)(
    "updates and retains a zone-level Zaraz config",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const original = yield* zaraz.getConfig({ zoneId: zoneId! });
        const toggledDataLayer = !original.dataLayer;

        yield* Effect.gen(function* () {
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Zaraz.Config("Config", {
                zone: { zoneId: zoneId!, name: zoneName },
                dataLayer: toggledDataLayer,
              });
            }),
          );

          expect(updated.zoneId).toEqual(zoneId);
          expect(updated.dataLayer).toEqual(toggledDataLayer);

          const liveUpdated = yield* zaraz.getConfig({ zoneId: zoneId! });
          expect(liveUpdated.dataLayer).toEqual(toggledDataLayer);

          const restored = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Zaraz.Config("Config", {
                zone: { zoneId: zoneId!, name: zoneName },
                dataLayer: original.dataLayer,
              });
            }),
          );

          expect(restored.dataLayer).toEqual(original.dataLayer);

          yield* stack.destroy();

          const liveRetained = yield* zaraz.getConfig({ zoneId: zoneId! });
          expect(liveRetained.dataLayer).toEqual(original.dataLayer);
        }).pipe(
          Effect.ensuring(
            zaraz.putConfig(toPutConfig(zoneId!, original)).pipe(Effect.ignore),
          ),
        );
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Same gate as above: mutates the zone-wide Zaraz singleton, so it requires
  // the dedicated opt-in zone from CLOUDFLARE_TEST_ZARAZ_ZONE_ID.
  test.provider.skipIf(!zoneId)(
    "delete true resets Zaraz config to defaults",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const original = yield* zaraz.getConfig({ zoneId: zoneId! });
        const originalWorkflow = yield* zaraz.getWorkflow({ zoneId: zoneId! });
        const defaults = yield* zaraz.getDefault({ zoneId: zoneId! });

        yield* Effect.gen(function* () {
          yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Zaraz.Config("Config", {
                zone: { zoneId: zoneId!, name: zoneName },
                dataLayer: !defaults.dataLayer,
                workflow: "preview",
                delete: true,
              });
            }),
          );

          const liveUpdated = yield* zaraz.getConfig({ zoneId: zoneId! });
          expect(liveUpdated.dataLayer).toEqual(!defaults.dataLayer);

          yield* stack.destroy();

          const liveDeleted = yield* zaraz.getConfig({ zoneId: zoneId! });
          expect(liveDeleted.dataLayer).toEqual(defaults.dataLayer);
          const liveDeletedWorkflow = yield* zaraz.getWorkflow({
            zoneId: zoneId!,
          });
          expect(liveDeletedWorkflow).toEqual("realtime");
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* zaraz
                .putConfig(toPutConfig(zoneId!, original))
                .pipe(Effect.ignore);
              yield* zaraz
                .putZaraz({ zoneId: zoneId!, workflow: originalWorkflow })
                .pipe(Effect.ignore);
            }),
          ),
        );
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Same gate as above: mutates the zone-wide Zaraz singleton, so it requires
  // the dedicated opt-in zone from CLOUDFLARE_TEST_ZARAZ_ZONE_ID.
  test.provider.skipIf(!zoneId)(
    "updates and retains Zaraz workflow mode",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const original = yield* zaraz.getWorkflow({ zoneId: zoneId! });
        const workflow = original === "realtime" ? "preview" : "realtime";

        yield* Effect.gen(function* () {
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Zaraz.Config("Config", {
                zone: { zoneId: zoneId!, name: zoneName },
                workflow,
              });
            }),
          );

          expect(updated.workflow).toEqual(workflow);

          const liveUpdated = yield* zaraz.getWorkflow({ zoneId: zoneId! });
          expect(liveUpdated).toEqual(workflow);

          yield* stack.destroy();

          const liveRetained = yield* zaraz.getWorkflow({ zoneId: zoneId! });
          expect(liveRetained).toEqual(workflow);
        }).pipe(
          Effect.ensuring(
            zaraz
              .putZaraz({ zoneId: zoneId!, workflow: original })
              .pipe(Effect.ignore),
          ),
        );
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for the per-zone Zaraz config, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Read-only — asserts the
  // result is well-typed, non-empty, and contains the standing test zone.
  test.provider(
    "list enumerates Zaraz config across all zones",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const zone = yield* findZoneByName({ accountId, name: zoneName });
        if (!zone) {
          return yield* Effect.die(
            new Error(`zone "${zoneName}" not found in account`),
          );
        }

        yield* stack.destroy();

        const provider = yield* Provider.findProvider(Cloudflare.Zaraz.Config);
        const all = yield* provider.list();

        expect(all.length).toBeGreaterThan(0);
        const row = all.find((c) => c.zoneId === zone.id);
        expect(row).toBeDefined();
        expect(typeof row!.zoneId).toBe("string");
        expect(typeof row!.dataLayer).toBe("boolean");
        expect(typeof row!.zarazVersion).toBe("number");
        expect(row!.settings).toBeDefined();
        expect(row!.workflow).toBeDefined();

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Ungated like the `list()` test: the deploy passes NO mutable props, so
  // reconcile observes the zone config, computes an identical desired config,
  // and skips putConfig/putZaraz entirely — the standing zone's singleton is
  // never mutated (capture-and-restore below is just a safety net).
  test.provider(
    "recovers a half-created config whose creating-state lost Output-valued props (#736)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { accountId } = yield* yield* CloudflareEnvironment;
        const zone = yield* findZoneByName({ accountId, name: zoneName });
        if (!zone) {
          return yield* Effect.die(
            new Error(`zone "${zoneName}" not found in account`),
          );
        }

        const original = yield* zaraz.getConfig({ zoneId: zone.id });

        yield* Effect.gen(function* () {
          const deployConfig = () =>
            stack.deploy(
              Effect.gen(function* () {
                // No mutable props: reconcile is a pure observe (no put).
                return yield* Cloudflare.Zaraz.Config("Config", {
                  zone: { zoneId: zone.id, name: zoneName },
                });
              }),
            );

          const created = yield* deployConfig();
          expect(created.zoneId).toEqual(zone.id);

          // Rewrite the persisted row into the wedged shape an interrupted
          // deploy leaves behind: `creating`, no attributes, and the
          // Output-valued `zone` prop lost in the round-trip (#736).
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
              r.row.resourceType === "Cloudflare.Zaraz.Config",
          );
          if (!wedged) {
            return yield* Effect.die(
              new Error(
                "no Cloudflare.Zaraz.Config state row found after deploy",
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
              props: {
                ...wedged.row.props,
                zone: undefined,
              },
            },
          });

          // Before the fix this crashed in read's recovery path with
          // `TypeError: undefined is not an object (evaluating 'zone.name')`.
          const recovered = yield* deployConfig();
          expect(recovered.zoneId).toEqual(created.zoneId);
          expect(recovered.dataLayer).toEqual(created.dataLayer);
          expect(recovered.workflow).toEqual(created.workflow);

          yield* stack.destroy();
        }).pipe(
          Effect.ensuring(
            // Safety net: restore only if something actually changed, so the
            // happy path leaves the standing zone's singleton untouched.
            Effect.gen(function* () {
              const current = yield* zaraz.getConfig({ zoneId: zone.id });
              if (!deepEqual(current, original)) {
                yield* zaraz.putConfig(toPutConfig(zone.id, original));
              }
            }).pipe(Effect.ignore),
          ),
        );
      }).pipe(logLevel),
    { timeout: 240_000 },
  );
});

type ConfigResponse = zaraz.GetConfigResponse | zaraz.PutConfigResponse;

const toPutConfig = (
  zoneId: string,
  config: ConfigResponse,
): zaraz.PutConfigRequest =>
  stripUndefinedFields({
    zoneId,
    dataLayer: config.dataLayer,
    debugKey: config.debugKey,
    settings: stripNullFields(config.settings),
    tools: config.tools,
    triggers: config.triggers,
    variables: config.variables,
    zarazVersion: config.zarazVersion,
    analytics: config.analytics ? stripNullFields(config.analytics) : undefined,
    consent: config.consent ? stripNullFields(config.consent) : undefined,
    historyChange: config.historyChange ?? undefined,
  }) as zaraz.PutConfigRequest;
