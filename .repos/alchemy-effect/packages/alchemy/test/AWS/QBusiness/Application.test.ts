import * as AWS from "@/AWS";
import {
  Application,
  DataSource,
  Index,
  Retriever,
  WebExperience,
} from "@/AWS/QBusiness";
import * as Test from "@/Test/Alchemy";
import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Amazon Q Business applications require an IAM Identity Center (or
// QuickSight/IAM IdP) identity source, which the shared testing account does
// not provision. The ungated probes assert the distilled wiring surfaces the
// typed errors the provider's read/delete and create paths depend on; the
// full lifecycle is gated behind AWS_TEST_QBUSINESS=1 (an account with an
// Identity Center instance, passed as QBUSINESS_IDC_INSTANCE_ARN).
describe("AWS.QBusiness.Application", () => {
  test.provider(
    "getApplication on a nonexistent id yields a typed ResourceNotFoundException",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* qbusiness
          .getApplication({
            applicationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "getIndex on a nonexistent application yields a typed ResourceNotFoundException",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* qbusiness
          .getIndex({
            applicationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            indexId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 60_000 },
  );

  // createApplication does NOT validate the Identity Center instance ARN
  // synchronously — the application is created and converges asynchronously
  // to the terminal FAILED status with an explanatory error detail. This
  // probe proves the exact create → observe-FAILED → delete flow the
  // provider's reconcile/delete paths depend on, without needing a real
  // Identity Center instance. The application never becomes ACTIVE, so
  // nothing bills.
  test.provider(
    "createApplication with a nonexistent Identity Center instance converges to FAILED and deletes cleanly",
    (_stack) =>
      Effect.gen(function* () {
        const displayName = "alchemy-qbusiness-probe";
        // Tolerate a leaked probe app from an interrupted prior run: a
        // duplicate create conflicts, so fall back to the existing one.
        const created = yield* qbusiness
          .createApplication({
            displayName,
            identityCenterInstanceArn:
              "arn:aws:sso:::instance/ssoins-0000000000000000",
          })
          .pipe(
            Effect.map((r) => r.applicationId),
            Effect.catchTag("ConflictException", () =>
              qbusiness
                .listApplications({})
                .pipe(
                  Effect.map(
                    (r) =>
                      r.applications?.find(
                        (a) =>
                          a.displayName === displayName &&
                          a.status !== "DELETING",
                      )?.applicationId,
                  ),
                ),
            ),
          );
        if (created === undefined) {
          return yield* Effect.die(
            new Error("no probe applicationId available"),
          );
        }
        const applicationId = created;

        yield* Effect.gen(function* () {
          // Converges to FAILED with a typed error detail.
          const failed = yield* qbusiness
            .getApplication({ applicationId })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (r) => r.status === "FAILED",
                times: 24,
              }),
            );
          expect(failed.status).toBe("FAILED");
          expect(failed.error?.errorMessage).toContain("Identity Center");
        }).pipe(
          // Always delete the probe application, even if assertions fail.
          Effect.ensuring(
            qbusiness.deleteApplication({ applicationId }).pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({}),
              ),
              Effect.ignore,
            ),
          ),
        );

        // Deletion initiated — DELETING or gone.
        const after = yield* qbusiness.getApplication({ applicationId }).pipe(
          Effect.map((r) => r.status ?? "gone"),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("gone" as const),
          ),
        );
        expect(["DELETING", "gone"]).toContain(after);
      }),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_QBUSINESS)(
    "create application + index + retriever + web experience, update, destroy, verify gone",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const identityCenterInstanceArn =
          process.env.QBUSINESS_IDC_INSTANCE_ARN;
        if (!identityCenterInstanceArn) {
          return yield* Effect.die(
            new Error(
              "AWS_TEST_QBUSINESS runs require QBUSINESS_IDC_INSTANCE_ARN",
            ),
          );
        }

        const deploy = (props: { description?: string }) =>
          stack.deploy(
            Effect.gen(function* () {
              const app = yield* Application("Assistant", {
                identityCenterInstanceArn,
                description: props.description,
                tags: { Environment: "test" },
              });

              const index = yield* Index("Docs", {
                applicationId: app.applicationId,
              });

              const retriever = yield* Retriever("Docs", {
                applicationId: app.applicationId,
                type: "NATIVE_INDEX",
                configuration: {
                  nativeIndexConfiguration: { indexId: index.indexId },
                },
              });

              // Role the data source connector assumes; CUSTOM sources need
              // index write access only.
              const dataRole = yield* AWS.IAM.Role("QBusinessDataRole", {
                assumeRolePolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: ["qbusiness.amazonaws.com"] },
                      Action: ["sts:AssumeRole"],
                    },
                  ],
                },
                inlinePolicies: {
                  ingest: {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: [
                          "qbusiness:BatchPutDocument",
                          "qbusiness:BatchDeleteDocument",
                        ],
                        Resource: ["*"],
                      },
                    ],
                  },
                },
              });

              const source = yield* DataSource("Custom", {
                applicationId: app.applicationId,
                indexId: index.indexId,
                roleArn: dataRole.roleArn,
                configuration: { type: "CUSTOM", version: "1.0.0" },
              });

              const web = yield* WebExperience("Chat", {
                applicationId: app.applicationId,
                title: "Alchemy Test Assistant",
              });

              return { app, index, retriever, source, web };
            }),
          );

        // Create — reconcile waits (bounded) for ACTIVE.
        const { app, index, retriever, source, web } = yield* deploy({});
        expect(app.applicationId).toBeDefined();
        expect(app.status).toBe("ACTIVE");
        expect(index.indexId).toBeDefined();
        expect(index.status).toBe("ACTIVE");
        expect(retriever.retrieverId).toBeDefined();
        expect(retriever.status).toBe("ACTIVE");
        expect(source.dataSourceId).toBeDefined();
        expect(source.status).toBe("ACTIVE");
        expect(web.webExperienceId).toBeDefined();
        expect(web.defaultEndpoint).toBeDefined();

        // Out-of-band verification via distilled.
        const described = yield* qbusiness.getApplication({
          applicationId: app.applicationId,
        });
        expect(described.status).toBe("ACTIVE");

        // Update in place — description flows through UpdateApplication.
        const updated = yield* deploy({ description: "updated by test" });
        expect(updated.app.applicationId).toBe(app.applicationId);
        const redescribed = yield* qbusiness.getApplication({
          applicationId: app.applicationId,
        });
        expect(redescribed.description).toBe("updated by test");

        yield* stack.destroy();

        // Typed wait-until-gone.
        yield* Effect.gen(function* () {
          const gone = yield* qbusiness
            .getApplication({ applicationId: app.applicationId })
            .pipe(
              Effect.map((d) => d.status === "DELETING"),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
          if (!gone) {
            return yield* Effect.fail({ _tag: "StillExists" as const });
          }
        }).pipe(
          Effect.retry({
            while: (e: { _tag: string }) => e._tag === "StillExists",
            schedule: Schedule.max([
              Schedule.spaced("15 seconds"),
              Schedule.recurs(40),
            ]),
          }),
        );
      }),
    { timeout: 3_600_000 },
  );
});
