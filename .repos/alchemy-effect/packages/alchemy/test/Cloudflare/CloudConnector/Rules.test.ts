import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudConnector from "@distilled.cloud/cloudflare/cloud-connector";
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

// Deterministic test constants — same values on every run.
const HOST_A = "alchemy-cloud-connector-a.s3.amazonaws.com";
const HOST_B = "alchemy-cloud-connector-b.s3.amazonaws.com";
const EXPRESSION_V1 = 'http.request.uri.path wildcard "/alchemy-cc/*"';
const EXPRESSION_V2 = 'http.request.uri.path wildcard "/alchemy-cc-v2/*"';
const EXPRESSION_B = 'http.request.uri.path wildcard "/alchemy-cc-b/*"';

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

// Ride out eventually-consistent 403s (freshly-minted scoped tokens
// propagate slowly across Cloudflare's edge) on the test's own
// out-of-band verification calls. `Forbidden` is part of the typed error
// union of both cloud-connector operations via distilled patches.
const forbiddenRetryPolicy = {
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const listLiveRules = (zoneId: string) =>
  cloudConnector.listRules({ zoneId }).pipe(
    Effect.map((response) => response.result),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
  );

// The zone's Cloud Connector rule list is a singleton; normalize it to the
// empty baseline so reruns are stable regardless of what a previous
// (possibly interrupted) run left behind.
const purgeRules = (zoneId: string) =>
  cloudConnector.putRule({ zoneId, rules: [] }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
  );

describe.sequential("Rules", () => {
  test.provider(
    "cloud connector rules — create, update in place, destroy clears the list",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* purgeRules(zoneId);

        // Create the singleton with a single S3 rule.
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.CloudConnector.Rules("Rules", {
              zoneId,
              rules: [
                {
                  provider: "aws_s3",
                  expression: EXPRESSION_V1,
                  host: HOST_A,
                  description: "alchemy cloud connector test",
                },
              ],
            }).pipe(adopt(true));
          }),
        );

        expect(initial.zoneId).toEqual(zoneId);
        expect(initial.rules).toHaveLength(1);
        expect(initial.rules[0].provider).toEqual("aws_s3");
        expect(initial.rules[0].expression).toEqual(EXPRESSION_V1);
        expect(initial.rules[0].host).toEqual(HOST_A);
        expect(initial.rules[0].enabled).toEqual(true);
        expect(initial.rules[0].id).toBeDefined();

        // Out-of-band verification against the live API.
        const live = yield* listLiveRules(zoneId);
        expect(live).toHaveLength(1);
        expect(live[0].expression).toEqual(EXPRESSION_V1);
        expect(live[0].parameters?.host).toEqual(HOST_A);

        // Update in place: change the first rule's expression and append a
        // second, disabled rule. Same identity — the singleton is replaced
        // atomically, not the resource.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.CloudConnector.Rules("Rules", {
              zoneId,
              rules: [
                {
                  provider: "aws_s3",
                  expression: EXPRESSION_V2,
                  host: HOST_A,
                  description: "alchemy cloud connector test v2",
                },
                {
                  provider: "aws_s3",
                  expression: EXPRESSION_B,
                  host: HOST_B,
                  enabled: false,
                },
              ],
            }).pipe(adopt(true));
          }),
        );

        expect(updated.zoneId).toEqual(zoneId);
        expect(updated.rules).toHaveLength(2);
        expect(updated.rules[0].expression).toEqual(EXPRESSION_V2);
        expect(updated.rules[0].host).toEqual(HOST_A);
        expect(updated.rules[1].expression).toEqual(EXPRESSION_B);
        expect(updated.rules[1].host).toEqual(HOST_B);
        expect(updated.rules[1].enabled).toEqual(false);

        const liveUpdated = yield* listLiveRules(zoneId);
        expect(liveUpdated).toHaveLength(2);
        expect(liveUpdated[0].expression).toEqual(EXPRESSION_V2);
        expect(liveUpdated[1].parameters?.host).toEqual(HOST_B);

        // Destroy clears the zone's rule list entirely.
        yield* stack.destroy();

        const liveGone = yield* listLiveRules(zoneId);
        expect(liveGone).toHaveLength(0);
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test.provider(
    "no-op redeploy leaves the rule list untouched and ids stable",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* purgeRules(zoneId);

        const deployOnce = stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.CloudConnector.Rules("Rules", {
              zoneId,
              rules: [
                {
                  provider: "aws_s3",
                  expression: EXPRESSION_V1,
                  host: HOST_A,
                  description: "alchemy cloud connector noop test",
                },
              ],
            }).pipe(adopt(true));
          }),
        );

        const first = yield* deployOnce;
        expect(first.rules).toHaveLength(1);
        const firstId = first.rules[0].id;
        expect(firstId).toBeDefined();

        // Redeploying identical desired state skips the PUT — the
        // server-assigned rule id survives.
        const second = yield* deployOnce;
        expect(second.rules).toHaveLength(1);
        expect(second.rules[0].id).toEqual(firstId);

        yield* stack.destroy();

        const liveGone = yield* listLiveRules(zoneId);
        expect(liveGone).toHaveLength(0);
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for the per-zone Cloud Connector rule list, so `list()` enumerates
  // every zone via `listAllZones` and reads its rules. Deploy a rule on the
  // standing test zone, then assert the test zone appears in the result with
  // the rule we created.
  test.provider(
    "list enumerates rule lists across all zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* purgeRules(zoneId);

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.CloudConnector.Rules("Rules", {
              zoneId,
              rules: [
                {
                  provider: "aws_s3",
                  expression: EXPRESSION_V1,
                  host: HOST_A,
                  description: "alchemy cloud connector list test",
                },
              ],
            }).pipe(adopt(true));
          }),
        );

        const provider = yield* Provider.findProvider(
          Cloudflare.CloudConnector.Rules,
        );
        const all = yield* provider.list();

        const entry = all.find((r) => r.zoneId === zoneId);
        expect(entry).toBeDefined();
        expect(
          entry!.rules.some((rule) => rule.expression === EXPRESSION_V1),
        ).toBe(true);

        yield* stack.destroy();
        yield* purgeRules(zoneId);
      }).pipe(logLevel),
    { timeout: 180_000 },
  );
});
