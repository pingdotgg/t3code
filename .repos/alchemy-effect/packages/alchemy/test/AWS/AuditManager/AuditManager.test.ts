import * as AWS from "@/AWS";
import { Assessment, Control, Framework } from "@/AWS/AuditManager";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Audit Manager must be registered per account (RegisterAccount) before any
// control/framework/assessment operation succeeds — registration is a
// account-level side effect, so the full lifecycle is gated behind
// AWS_TEST_AUDITMANAGER=1. The ungated probes below prove the distilled
// wiring and the typed error union at near-zero cost in every CI pass.
describe("AWS.AuditManager", () => {
  test.provider(
    "getAccountStatus returns a typed account status",
    (_stack) =>
      Effect.gen(function* () {
        const response = yield* auditmanager.getAccountStatus({});
        expect(["ACTIVE", "INACTIVE", "PENDING_ACTIVATION"]).toContain(
          response.status,
        );
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "getControl on a nonexistent id yields a typed error tag",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* auditmanager
          .getControl({ controlId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })
          .pipe(Effect.flip);
        // Registered accounts answer ResourceNotFoundException; unregistered
        // accounts reject every control op with AccessDeniedException. Both
        // are typed tags in the distilled union — the provider's read path
        // depends on the former.
        expect([
          "ResourceNotFoundException",
          "AccessDeniedException",
        ]).toContain(error._tag);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "registerAccount is typed: idempotent on registered accounts, AuditManagerMaintenanceMode otherwise",
    (_stack) =>
      Effect.gen(function* () {
        const { status } = yield* auditmanager.getAccountStatus({});
        if (status === "ACTIVE") {
          // Already registered — re-registering is an idempotent no-op.
          const response = yield* auditmanager.registerAccount({});
          expect(response.status).toBe("ACTIVE");
        } else {
          // Audit Manager entered maintenance mode on 2026-04-30: new
          // accounts can no longer be registered. The rejection surfaces as
          // the typed tag patched into distilled (patches/auditmanager.json).
          const error = yield* Effect.flip(auditmanager.registerAccount({}));
          expect(error._tag).toBe("AuditManagerMaintenanceMode");
        }
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_AUDITMANAGER)(
    "control + framework + assessment lifecycle: create, update, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Ensure the account is registered and wait for ACTIVE. On accounts
        // that never enabled Audit Manager this fails with the typed
        // AuditManagerMaintenanceMode tag — the service is in maintenance
        // mode and new registrations are permanently rejected.
        const { status } = yield* auditmanager.getAccountStatus({});
        if (status !== "ACTIVE") {
          yield* auditmanager.registerAccount({});
          yield* Effect.gen(function* () {
            const current = yield* auditmanager.getAccountStatus({});
            if (current.status !== "ACTIVE") {
              return yield* Effect.fail({
                _tag: "NotActive" as const,
                status: current.status,
              });
            }
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "NotActive",
              schedule: Schedule.max([
                Schedule.spaced("5 seconds"),
                Schedule.recurs(12),
              ]),
            }),
          );
        }

        const deploy = (props: {
          controlDescription?: string;
          frameworkDescription?: string;
          assessmentDescription?: string;
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const control = yield* Control("EvidenceControl", {
                description: props.controlDescription,
                controlMappingSources: [
                  {
                    sourceName: "manual-evidence",
                    sourceDescription: "Manually uploaded evidence",
                    sourceSetUpOption: "Procedural_Controls_Mapping",
                    sourceType: "MANUAL",
                  },
                ],
                tags: { fixture: "auditmanager" },
              });

              const framework = yield* Framework("ComplianceFramework", {
                description: props.frameworkDescription,
                complianceType: "Internal",
                controlSets: [
                  {
                    name: "Operations",
                    controls: [{ id: control.controlId }],
                  },
                ],
                tags: { fixture: "auditmanager" },
              });

              const reports = yield* AWS.S3.Bucket("AuditReports", {
                forceDestroy: true,
              });

              const owner = yield* AWS.IAM.Role("AuditOwner", {
                assumeRolePolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: ["auditmanager.amazonaws.com"] },
                      Action: ["sts:AssumeRole"],
                    },
                  ],
                },
              });

              const assessment = yield* Assessment("Quarterly", {
                description: props.assessmentDescription,
                frameworkId: framework.frameworkId,
                assessmentReportsDestination: {
                  destination: Output.interpolate`s3://${reports.bucketName}`,
                },
                roles: [{ roleType: "PROCESS_OWNER", roleArn: owner.roleArn }],
                tags: { fixture: "auditmanager" },
              });

              return { control, framework, assessment };
            }),
          );

        // Create.
        const { control, framework, assessment } = yield* deploy({
          controlDescription: "initial control",
          frameworkDescription: "initial framework",
          assessmentDescription: "initial assessment",
        });
        expect(control.controlId).toBeDefined();
        expect(control.arn).toContain(":control/");
        expect(control.type).toBe("Custom");
        expect(framework.frameworkId).toBeDefined();
        expect(framework.type).toBe("Custom");
        expect(assessment.assessmentId).toBeDefined();
        expect(assessment.status).toBe("ACTIVE");
        expect(assessment.frameworkId).toBe(framework.frameworkId);

        // Out-of-band verification via distilled.
        const observedControl = yield* auditmanager.getControl({
          controlId: control.controlId,
        });
        expect(observedControl.control?.name).toBe(control.name);
        const observedFramework = yield* auditmanager.getAssessmentFramework({
          frameworkId: framework.frameworkId,
        });
        expect(
          observedFramework.framework?.controlSets?.[0]?.controls?.[0]?.id,
        ).toBe(control.controlId);
        const observedAssessment = yield* auditmanager.getAssessment({
          assessmentId: assessment.assessmentId,
        });
        expect(observedAssessment.assessment?.framework?.id).toBe(
          framework.frameworkId,
        );

        // Update in place — descriptions flow through the update APIs and
        // ids are stable.
        const updated = yield* deploy({
          controlDescription: "updated control",
          frameworkDescription: "updated framework",
          assessmentDescription: "updated assessment",
        });
        expect(updated.control.controlId).toBe(control.controlId);
        expect(updated.framework.frameworkId).toBe(framework.frameworkId);
        expect(updated.assessment.assessmentId).toBe(assessment.assessmentId);
        const reobservedFramework = yield* auditmanager.getAssessmentFramework({
          frameworkId: framework.frameworkId,
        });
        expect(reobservedFramework.framework?.description).toBe(
          "updated framework",
        );

        yield* stack.destroy();

        // Typed wait-until-gone for each resource.
        const assertGone = Effect.gen(function* () {
          const controlGone = yield* auditmanager
            .getControl({ controlId: control.controlId })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
          const frameworkGone = yield* auditmanager
            .getAssessmentFramework({ frameworkId: framework.frameworkId })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
          const assessmentGone = yield* auditmanager
            .getAssessment({ assessmentId: assessment.assessmentId })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
          if (!controlGone || !frameworkGone || !assessmentGone) {
            return yield* Effect.fail({ _tag: "StillExists" as const });
          }
        }).pipe(
          Effect.retry({
            while: (e: { _tag: string }) => e._tag === "StillExists",
            schedule: Schedule.max([
              Schedule.spaced("5 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
        yield* assertGone;
      }),
    { timeout: 600_000 },
  );
});
