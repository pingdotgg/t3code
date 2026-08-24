import * as AWS from "@/AWS";
import { ConfigurationRecorder, DeliveryChannel } from "@/AWS/Config";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/aws/config-service";
import * as iam from "@distilled.cloud/aws/iam";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeConfigTestLease } from "./TestLease.ts";

const { test } = Test.make({ providers: AWS.providers() });
const testLease = makeConfigTestLease();

// Ungated typed-error probes: prove the distilled error unions carry the
// not-found tags the recorder/channel providers' read/delete paths depend
// on. Run in every CI pass at near-zero cost, unlike the gated lifecycle
// below.
test.provider(
  "describeConfigurationRecorders on a nonexistent recorder fails with NoSuchConfigurationRecorderException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        config.describeConfigurationRecorders({
          ConfigurationRecorderNames: ["alchemy-nonexistent-recorder-probe"],
        }),
      );
      expect(error._tag).toBe("NoSuchConfigurationRecorderException");
    }),
);

test.provider(
  "describeDeliveryChannels on a nonexistent channel fails with NoSuchDeliveryChannelException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        config.describeDeliveryChannels({
          DeliveryChannelNames: ["alchemy-nonexistent-channel-probe"],
        }),
      );
      expect(error._tag).toBe("NoSuchDeliveryChannelException");
    }),
);

// AWS allows only ONE customer managed configuration recorder and ONE
// delivery channel per account per region, so the full lifecycle is an
// account-region singleton mutation — gated behind AWS_TEST_CONFIG_RECORDER=1.
// The gated run requires the account/region to have NO existing recorder.
test.provider.skipIf(!process.env.AWS_TEST_CONFIG_RECORDER)(
  "create recorder + delivery channel, start/stop recording, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Preflight: refuse to clobber a foreign recorder.
      const preexisting = yield* config.describeConfigurationRecorders({});
      if ((preexisting.ConfigurationRecorders ?? []).length > 0) {
        return yield* Effect.die(
          new Error(
            "account/region already has a configuration recorder — the gated singleton lifecycle requires a clean account/region",
          ),
        );
      }

      // The recorder assumes the Config service-linked role.
      yield* iam
        .createServiceLinkedRole({ AWSServiceName: "config.amazonaws.com" })
        .pipe(
          Effect.catchTag("InvalidInputException", () =>
            Effect.succeed(undefined),
          ),
        );
      const role = yield* iam.getRole({ RoleName: "AWSServiceRoleForConfig" });
      const roleArn = role.Role.Arn;
      const { Account: accountId } = yield* sts.getCallerIdentity({});
      const bucketName = `alchemy-config-delivery-${accountId}`;
      const bucketArn = `arn:aws:s3:::${bucketName}`;

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DeliveryBucket", {
            bucketName,
            forceDestroy: true,
            policy: [
              {
                Effect: "Allow",
                Principal: { Service: "config.amazonaws.com" },
                Action: ["s3:GetBucketAcl", "s3:ListBucket"],
                Resource: [bucketArn],
              },
              {
                Effect: "Allow",
                Principal: { Service: "config.amazonaws.com" },
                Action: ["s3:PutObject"],
                Resource: [`${bucketArn}/AWSLogs/${accountId}/Config/*`],
                Condition: {
                  StringEquals: {
                    "s3:x-amz-acl": "bucket-owner-full-control",
                  },
                },
              },
            ],
          });
          const recorder = yield* ConfigurationRecorder("Recorder", {
            roleArn,
            recordingGroup: { resourceTypes: ["AWS::S3::Bucket"] },
          });
          const channel = yield* DeliveryChannel("Channel", {
            s3BucketName: bucket.bucketName,
          });
          return { recorder, channel };
        }),
      );

      expect(outputs.recorder.recorderName).toBeDefined();
      expect(outputs.recorder.recorderArn).toContain(
        ":configuration-recorder/",
      );
      expect(outputs.channel.deliveryChannelName).toBeDefined();
      expect(outputs.channel.s3BucketName).toBe(bucketName);

      // Out-of-band verification via distilled.
      const described = yield* config.describeConfigurationRecorders({
        ConfigurationRecorderNames: [outputs.recorder.recorderName],
      });
      const observed = (described.ConfigurationRecorders ?? []).at(0);
      expect(observed?.roleARN).toBe(roleArn);
      expect(observed?.recordingGroup?.resourceTypes).toEqual([
        "AWS::S3::Bucket",
      ]);
      const channels = yield* config.describeDeliveryChannels({
        DeliveryChannelNames: [outputs.channel.deliveryChannelName],
      });
      expect((channels.DeliveryChannels ?? []).at(0)?.s3BucketName).toBe(
        bucketName,
      );

      // Start recording (requires the delivery channel), verify, stop.
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DeliveryBucket", {
            bucketName,
            forceDestroy: true,
          });
          const recorder = yield* ConfigurationRecorder("Recorder", {
            roleArn,
            recordingGroup: { resourceTypes: ["AWS::S3::Bucket"] },
            recording: true,
          });
          const channel = yield* DeliveryChannel("Channel", {
            s3BucketName: bucket.bucketName,
          });
          return { recorder, channel };
        }),
      );
      const startedStatus = yield* config.describeConfigurationRecorderStatus({
        ConfigurationRecorderNames: [outputs.recorder.recorderName],
      });
      expect(
        (startedStatus.ConfigurationRecordersStatus ?? []).at(0)?.recording,
      ).toBe(true);

      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DeliveryBucket", {
            bucketName,
            forceDestroy: true,
          });
          const recorder = yield* ConfigurationRecorder("Recorder", {
            roleArn,
            recordingGroup: { resourceTypes: ["AWS::S3::Bucket"] },
            recording: false,
          });
          const channel = yield* DeliveryChannel("Channel", {
            s3BucketName: bucket.bucketName,
          });
          return { recorder, channel };
        }),
      );
      const stoppedStatus = yield* config.describeConfigurationRecorderStatus({
        ConfigurationRecorderNames: [outputs.recorder.recorderName],
      });
      expect(
        (stoppedStatus.ConfigurationRecordersStatus ?? []).at(0)?.recording,
      ).toBe(false);

      // Destroy and verify both singletons are gone (deletion is
      // synchronous for recorder and channel).
      yield* stack.destroy();
      const recorderGone = yield* Effect.flip(
        config.describeConfigurationRecorders({
          ConfigurationRecorderNames: [outputs.recorder.recorderName],
        }),
      );
      expect(recorderGone._tag).toBe("NoSuchConfigurationRecorderException");
      const channelGone = yield* Effect.flip(
        config.describeDeliveryChannels({
          DeliveryChannelNames: [outputs.channel.deliveryChannelName],
        }),
      );
      expect(channelGone._tag).toBe("NoSuchDeliveryChannelException");
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)), testLease.use),
  { timeout: 240_000 },
);
