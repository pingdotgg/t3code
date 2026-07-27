import * as AWS from "@/AWS";
import { EnabledBaseline, EnabledControl } from "@/AWS/ControlTower";
import * as Test from "@/Test/Alchemy";
import * as controltower from "@distilled.cloud/aws/controltower";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// AWS Control Tower requires an AWS Organizations MANAGEMENT account with a
// landing zone deployed — neither is available on the shared testing
// account, so every lifecycle is hard-gated behind AWS_TEST_CONTROLTOWER=1.
// The ungated probes below prove the distilled wiring and typed error
// unions the providers' read/delete paths depend on, at near-zero cost.

describe("AWS.ControlTower", () => {
  test.provider(
    "getLandingZoneOperation on a bogus operation id yields a typed error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          controltower.getLandingZoneOperation({
            operationIdentifier: "00000000-0000-0000-0000-000000000000",
          }),
        );
        // A well-formed but absent operation id yields the typed
        // ResourceNotFoundException the providers' waiters depend on —
        // even on an account without a landing zone.
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "listLandingZones yields a typed result",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(controltower.listLandingZones({}));
        if (Result.isSuccess(result)) {
          // No landing zone on the testing account — an empty (or singleton)
          // list, never a crash.
          expect(Array.isArray(result.success.landingZones)).toBe(true);
        } else {
          // Some org configurations reject the call outright — but always
          // with a typed tag (UnauthorizedException is a distilled patch).
          expect(["AccessDeniedException", "UnauthorizedException"]).toContain(
            result.failure._tag,
          );
        }
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "getEnabledControl on a nonexistent identifier yields a typed error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          controltower.getEnabledControl({
            enabledControlIdentifier:
              "arn:aws:controltower:us-west-2:111111111111:enabledcontrol/AAAAAAAAAAAAAAAA",
          }),
        );
        // Both a genuinely absent enabled control and a no-landing-zone
        // account surface the typed ResourceNotFoundException the
        // provider's observe/delete paths depend on.
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "getEnabledBaseline on a nonexistent identifier yields a typed error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          controltower.getEnabledBaseline({
            enabledBaselineIdentifier:
              "arn:aws:controltower:us-west-2:111111111111:enabledbaseline/AAAAAAAAAAAAAAAA",
          }),
        );
        // The baseline API family rejects accounts without a landing zone
        // with the wire error UnauthorizedException, which the Smithy model
        // omits — surfaced as a typed tag via the distilled patch. An
        // entitled account yields ResourceNotFoundException instead.
        expect([
          "UnauthorizedException",
          "ResourceNotFoundException",
        ]).toContain(error._tag);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "listBaselines yields a typed result",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(controltower.listBaselines({}));
        if (Result.isSuccess(result)) {
          // The baseline catalog is served even without a landing zone.
          expect(result.success.baselines.length).toBeGreaterThan(0);
          expect(
            result.success.baselines.some(
              (b) => b.name === "AWSControlTowerBaseline",
            ),
          ).toBe(true);
        } else {
          expect(["AccessDeniedException", "UnauthorizedException"]).toContain(
            result.failure._tag,
          );
        }
      }),
    { timeout: 60_000 },
  );

  // ---------------------------------------------------------------------
  // Gated lifecycles — need an Organizations management account with a
  // Control Tower landing zone. Provide:
  //   AWS_TEST_CONTROLTOWER=1
  //   AWS_TEST_CONTROLTOWER_OU        target OU ARN (unregistered OU for
  //                                   the baseline test)
  //   AWS_TEST_CONTROLTOWER_CONTROL   control ARN (defaults to the
  //                                   AWS-GR_ENCRYPTED_VOLUMES legacy ARN
  //                                   in us-west-2)
  //   AWS_TEST_CONTROLTOWER_BASELINE_VERSION  (defaults to "4.0")
  // ---------------------------------------------------------------------

  const ouArn = process.env.AWS_TEST_CONTROLTOWER_OU ?? "";
  const controlArn =
    process.env.AWS_TEST_CONTROLTOWER_CONTROL ??
    "arn:aws:controltower:us-west-2::control/AWS-GR_ENCRYPTED_VOLUMES";

  test.provider.skipIf(!process.env.AWS_TEST_CONTROLTOWER)(
    "enable a control on an OU, verify, then disable",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { enabled } = yield* stack.deploy(
          Effect.gen(function* () {
            const enabled = yield* EnabledControl("Guardrail", {
              controlIdentifier: controlArn,
              targetIdentifier: ouArn,
              tags: { fixture: "controltower-enabled-control" },
            });
            return { enabled };
          }),
        );

        expect(enabled.enabledControlArn).toContain(":enabledcontrol/");
        expect(enabled.controlIdentifier).toBe(controlArn);
        expect(enabled.targetIdentifier).toBe(ouArn);

        // Out-of-band verification via distilled.
        const observed = yield* controltower.getEnabledControl({
          enabledControlIdentifier: enabled.enabledControlArn,
        });
        expect(observed.enabledControlDetails.controlIdentifier).toBe(
          controlArn,
        );
        expect(observed.enabledControlDetails.statusSummary?.status).toBe(
          "SUCCEEDED",
        );

        // Destroy and verify the enablement is gone (typed wait-until-gone).
        yield* stack.destroy();
        yield* controltower
          .getEnabledControl({
            enabledControlIdentifier: enabled.enabledControlArn,
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.fail(new Error("enabled control still exists")),
            ),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.fixed("10 seconds"),
                Schedule.recurs(18),
              ]),
            }),
          );
      }),
    // enable (~minutes) + disable (~minutes), one test.
    { timeout: 1_500_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_CONTROLTOWER)(
    "enable the Control Tower baseline on an OU, verify, then disable",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Discover the AWSControlTowerBaseline ARN dynamically.
        const baselines = yield* controltower.listBaselines.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.baselines),
          ),
        );
        const controlTowerBaseline = baselines.find(
          (b) => b.name === "AWSControlTowerBaseline",
        );
        expect(controlTowerBaseline).toBeDefined();
        const baselineVersion =
          process.env.AWS_TEST_CONTROLTOWER_BASELINE_VERSION ?? "4.0";

        const { enabled } = yield* stack.deploy(
          Effect.gen(function* () {
            const enabled = yield* EnabledBaseline("OuBaseline", {
              baselineIdentifier: controlTowerBaseline!.arn,
              baselineVersion,
              targetIdentifier: ouArn,
              tags: { fixture: "controltower-enabled-baseline" },
            });
            return { enabled };
          }),
        );

        expect(enabled.enabledBaselineArn).toContain(":enabledbaseline/");
        expect(enabled.baselineIdentifier).toBe(controlTowerBaseline!.arn);
        expect(enabled.targetIdentifier).toBe(ouArn);

        // Out-of-band verification via distilled.
        const observed = yield* controltower.getEnabledBaseline({
          enabledBaselineIdentifier: enabled.enabledBaselineArn,
        });
        expect(observed.enabledBaselineDetails?.statusSummary.status).toBe(
          "SUCCEEDED",
        );

        // Destroy and verify the enablement is gone (typed wait-until-gone).
        yield* stack.destroy();
        yield* controltower
          .getEnabledBaseline({
            enabledBaselineIdentifier: enabled.enabledBaselineArn,
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.fail(new Error("enabled baseline still exists")),
            ),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.fixed("10 seconds"),
                Schedule.recurs(18),
              ]),
            }),
          );
      }),
    { timeout: 1_500_000 },
  );

  // The LandingZone resource's create/decommission paths are implemented
  // but deliberately NOT exercised even when gated — decommissioning a
  // live organization's landing zone is an irreversible ~1 hour operation.
  // On an entitled account this asserts the observe/read path end-to-end.
  test.provider.skipIf(!process.env.AWS_TEST_CONTROLTOWER)(
    "landing zone read path resolves the deployed landing zone",
    () =>
      Effect.gen(function* () {
        const { landingZones } = yield* controltower.listLandingZones({});
        expect(landingZones.length).toBe(1);
        const arn = landingZones[0]!.arn!;
        const { landingZone } = yield* controltower.getLandingZone({
          landingZoneIdentifier: arn,
        });
        expect(landingZone.version).toBeDefined();
        expect(landingZone.status).toBeDefined();
      }),
    { timeout: 120_000 },
  );
});
