import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as diagnostics from "@distilled.cloud/cloudflare/diagnostics";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getHealthcheck = (accountId: string, id: string) =>
  diagnostics.getEndpointHealthcheck({ accountId, id });

// A GET issued immediately after a create/update can transiently 404
// (`EndpointHealthcheckNotFound`, code 1022) while the new state
// propagates across Cloudflare's edge — bounded-retry the out-of-band
// verification read until it resolves.
const getHealthcheckLive = (accountId: string, id: string) =>
  getHealthcheck(accountId, id).pipe(
    Effect.retry({
      while: (e) => e._tag === "EndpointHealthcheckNotFound",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Poll until the healthcheck is gone after destroy. Cloudflare answers
// GET for a missing healthcheck with the typed
// `EndpointHealthcheckNotFound` (code 1022, 404).
const expectGone = (accountId: string, id: string) =>
  getHealthcheck(accountId, id).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "HealthcheckNotDeleted" } as const),
    ),
    Effect.catchTag("EndpointHealthcheckNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "HealthcheckNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "rejects public IPs with the typed InvalidHealthcheckEndpoint error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Cloudflare only accepts on-net (private) IPs; a public IP fails
      // with code 1002 — pinned here as the typed tag.
      const error = yield* diagnostics
        .createEndpointHealthcheck({
          accountId,
          checkType: "icmp",
          endpoint: "1.1.1.1",
          name: "alchemy-diag-ehc-invalid-probe",
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidHealthcheckEndpoint");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Out-of-band cleanup of healthchecks leaked by previous failed runs —
// the test state store does not persist across runs, so a mid-test
// failure leaves the cloud resource behind and the cold read would
// (correctly) gate it behind the adopt policy.
const cleanLeftovers = (accountId: string) =>
  diagnostics.listEndpointHealthchecks({ accountId }).pipe(
    Effect.flatMap(
      Effect.fn(function* (list) {
        for (const hc of list) {
          if (hc.name?.startsWith("alchemy-diag-ehc") && hc.id) {
            yield* diagnostics
              .deleteEndpointHealthcheck({ accountId, id: hc.id })
              .pipe(
                Effect.catchTag(
                  "EndpointHealthcheckNotFound",
                  () => Effect.void,
                ),
              );
          }
        }
      }),
    ),
  );

test.provider(
  "creates an endpoint healthcheck, updates in place, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* cleanLeftovers(accountId);

      const check = yield* stack.deploy(
        Cloudflare.Diagnostics.EndpointHealthcheck("Check", {
          endpoint: "10.77.0.1",
          name: "alchemy-diag-ehc",
        }),
      );

      expect(check.healthcheckId).toBeTruthy();
      expect(check.accountId).toEqual(accountId);
      expect(check.checkType).toEqual("icmp");
      expect(check.endpoint).toEqual("10.77.0.1");
      expect(check.name).toEqual("alchemy-diag-ehc");

      // Out-of-band verification via the distilled API.
      const live = yield* getHealthcheckLive(accountId, check.healthcheckId);
      expect(live.endpoint).toEqual("10.77.0.1");
      expect(live.name).toEqual("alchemy-diag-ehc");

      // Update the probed endpoint in place — same UUID.
      const updated = yield* stack.deploy(
        Cloudflare.Diagnostics.EndpointHealthcheck("Check", {
          endpoint: "10.77.0.2",
          name: "alchemy-diag-ehc",
        }),
      );
      expect(updated.healthcheckId).toEqual(check.healthcheckId);
      expect(updated.endpoint).toEqual("10.77.0.2");
      expect(updated.name).toEqual("alchemy-diag-ehc");

      const liveUpdated = yield* getHealthcheckLive(
        accountId,
        check.healthcheckId,
      );
      expect(liveUpdated.endpoint).toEqual("10.77.0.2");
      expect(liveUpdated.name).toEqual("alchemy-diag-ehc");

      // No-op deploy — converges without churn, same UUID.
      const noop = yield* stack.deploy(
        Cloudflare.Diagnostics.EndpointHealthcheck("Check", {
          endpoint: "10.77.0.2",
          name: "alchemy-diag-ehc",
        }),
      );
      expect(noop.healthcheckId).toEqual(check.healthcheckId);

      // Changing the name is create-only on Cloudflare's side — the
      // resource is replaced with a fresh UUID and the old one removed.
      // The endpoint changes too: endpoints are unique per account and
      // replacement creates the new healthcheck before deleting the old.
      const replaced = yield* stack.deploy(
        Cloudflare.Diagnostics.EndpointHealthcheck("Check", {
          endpoint: "10.77.0.3",
          name: "alchemy-diag-ehc-v2",
        }),
      );
      expect(replaced.healthcheckId).not.toEqual(check.healthcheckId);
      expect(replaced.name).toEqual("alchemy-diag-ehc-v2");
      yield* expectGone(accountId, check.healthcheckId);

      const liveReplaced = yield* getHealthcheckLive(
        accountId,
        replaced.healthcheckId,
      );
      expect(liveReplaced.name).toEqual("alchemy-diag-ehc-v2");

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.healthcheckId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// Canonical `list()` test (account collection): deploy a real healthcheck,
// then assert its UUID appears in the exhaustively-enumerated result.
test.provider(
  "list enumerates the deployed endpoint healthcheck",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* cleanLeftovers(accountId);

      const deployed = yield* stack.deploy(
        Cloudflare.Diagnostics.EndpointHealthcheck("ListCheck", {
          endpoint: "10.78.0.1",
          name: "alchemy-diag-ehc-list",
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Diagnostics.EndpointHealthcheck,
      );
      const all = yield* provider.list();

      expect(
        all.some((hc) => hc.healthcheckId === deployed.healthcheckId),
      ).toBe(true);
      // Each listed item is the full `read` Attributes shape.
      const found = all.find(
        (hc) => hc.healthcheckId === deployed.healthcheckId,
      );
      expect(found?.accountId).toEqual(accountId);
      expect(found?.endpoint).toEqual("10.78.0.1");
      expect(found?.checkType).toEqual("icmp");

      yield* stack.destroy();
      yield* expectGone(accountId, deployed.healthcheckId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
