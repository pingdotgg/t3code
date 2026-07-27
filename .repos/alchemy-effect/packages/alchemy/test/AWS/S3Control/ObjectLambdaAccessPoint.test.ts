import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { AccessPoint, ObjectLambdaAccessPoint } from "@/AWS/S3Control";
import * as Test from "@/Test/Alchemy";
import * as s3control from "@distilled.cloud/aws/s3-control";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  ObjectTransformFunction,
  ObjectTransformFunctionLive,
} from "./fixtures/transform-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

const ACCOUNT_ID = "391965393224";

const findObjectLambdaAccessPoint = (name: string) =>
  s3control
    .getAccessPointForObjectLambda({ AccountId: ACCOUNT_ID, Name: name })
    .pipe(
      Effect.catchTag("NoSuchAccessPoint", () => Effect.succeed(undefined)),
    );

class ObjectLambdaAccessPointStillExists extends Data.TaggedError(
  "ObjectLambdaAccessPointStillExists",
)<{ readonly name: string }> {}

const assertObjectLambdaAccessPointDeleted = (name: string) =>
  findObjectLambdaAccessPoint(name).pipe(
    Effect.flatMap((olap) =>
      olap === undefined
        ? Effect.void
        : Effect.fail(new ObjectLambdaAccessPointStillExists({ name })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ObjectLambdaAccessPointStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "typed NoSuchAccessPoint tag on a nonexistent object lambda access point",
  () =>
    Effect.gen(function* () {
      const result = yield* s3control
        .getAccessPointForObjectLambda({
          AccountId: ACCOUNT_ID,
          Name: "alchemy-does-not-exist-xyz",
        })
        .pipe(
          Effect.map(() => "found" as const),
          Effect.catchTag("NoSuchAccessPoint", () =>
            Effect.succeed("missing" as const),
          ),
        );
      expect(result).toBe("missing");
    }),
  { timeout: 60_000 },
);

// S3 Object Lambda is entitlement-gated: "Amazon S3 Object Lambda is
// available only to existing customers that are currently using the service
// as well as to select AWS Partner Network (APN) partners." (AccessDenied on
// CreateAccessPointForObjectLambda, surfaced as the typed
// ObjectLambdaNotAvailable tag). This probe pins the typed tag; an entitled
// account instead fails with NoSuchAccessPoint for the bogus supporting AP.
test.provider(
  "typed ObjectLambdaNotAvailable tag on a non-entitled account",
  () =>
    Effect.gen(function* () {
      const result = yield* s3control
        .createAccessPointForObjectLambda({
          AccountId: ACCOUNT_ID,
          Name: "alchemy-olap-entitlement-probe",
          Configuration: {
            SupportingAccessPoint: `arn:aws:s3:us-west-2:${ACCOUNT_ID}:accesspoint/alchemy-does-not-exist-xyz`,
            TransformationConfigurations: [
              {
                Actions: ["GetObject"],
                ContentTransformation: {
                  AwsLambda: {
                    FunctionArn: `arn:aws:lambda:us-west-2:${ACCOUNT_ID}:function:does-not-exist`,
                  },
                },
              },
            ],
          },
        })
        .pipe(
          Effect.map(() => "created" as const),
          Effect.catchTag("ObjectLambdaNotAvailable", () =>
            Effect.succeed("gated" as const),
          ),
          Effect.catchTag("NoSuchAccessPoint", () =>
            Effect.succeed("missing-supporting-ap" as const),
          ),
        );
      // this account is not entitled; an entitled account would reach the
      // supporting-access-point validation instead
      expect(["gated", "missing-supporting-ap"]).toContain(result);
      // never actually created
      expect(result).not.toBe("created");
    }),
  { timeout: 60_000 },
);

// Full lifecycle requires an account entitled to S3 Object Lambda (the
// service is closed to new customers) — gate it so entitled accounts can
// still run it unchanged: AWS_TEST_OBJECT_LAMBDA=1.
test.provider.skipIf(!process.env.AWS_TEST_OBJECT_LAMBDA)(
  "create, update configuration, delete object lambda access point",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (cloudWatchMetricsEnabled: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* Bucket("OlapBucket", { forceDestroy: true });
          const accessPoint = yield* AccessPoint("OlapSupportingAp", {
            bucket: bucket.bucketName,
          });
          const transformer = yield* ObjectTransformFunction.pipe(
            Effect.provide(ObjectTransformFunctionLive),
          );
          const olap = yield* ObjectLambdaAccessPoint("TestOlap", {
            supportingAccessPoint: accessPoint.accessPointArn,
            cloudWatchMetricsEnabled,
            transformationConfigurations: [
              {
                Actions: ["GetObject"],
                ContentTransformation: {
                  AwsLambda: { FunctionArn: transformer.functionArn },
                },
              },
            ],
          });
          return { accessPoint, olap };
        });

      const deployed = yield* stack.deploy(makeStack(false));

      expect(deployed.olap.objectLambdaAccessPointName).toBeDefined();
      expect(deployed.olap.objectLambdaAccessPointArn).toContain(
        ":s3-object-lambda:",
      );

      // out-of-band verification via distilled
      const live = yield* findObjectLambdaAccessPoint(
        deployed.olap.objectLambdaAccessPointName,
      );
      expect(live).toBeDefined();

      const config =
        yield* s3control.getAccessPointConfigurationForObjectLambda({
          AccountId: ACCOUNT_ID,
          Name: deployed.olap.objectLambdaAccessPointName,
        });
      expect(config.Configuration?.SupportingAccessPoint).toBe(
        deployed.accessPoint.accessPointArn,
      );
      expect(config.Configuration?.CloudWatchMetricsEnabled ?? false).toBe(
        false,
      );

      // update the mutable configuration in place — same access point
      const updated = yield* stack.deploy(makeStack(true));
      expect(updated.olap.objectLambdaAccessPointName).toBe(
        deployed.olap.objectLambdaAccessPointName,
      );

      const updatedConfig =
        yield* s3control.getAccessPointConfigurationForObjectLambda({
          AccountId: ACCOUNT_ID,
          Name: deployed.olap.objectLambdaAccessPointName,
        });
      expect(updatedConfig.Configuration?.CloudWatchMetricsEnabled).toBe(true);

      yield* stack.destroy();
      yield* assertObjectLambdaAccessPointDeleted(
        deployed.olap.objectLambdaAccessPointName,
      );
    }),
  { timeout: 240_000 },
);
