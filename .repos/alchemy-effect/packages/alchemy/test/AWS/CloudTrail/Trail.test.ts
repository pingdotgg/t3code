import * as AWS from "@/AWS";
import {
  Trail,
  type TrailAdvancedEventSelector,
  type TrailInsightSelector,
} from "@/AWS/CloudTrail";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import * as Test from "@/Test/Alchemy";
import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost.
test.provider(
  "getTrail on a nonexistent trail fails with TrailNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        cloudtrail.getTrail({ Name: "alchemy-nonexistent-trail-probe" }),
      );
      expect(error._tag).toBe("TrailNotFoundException");
    }),
);

const TRAIL_NAME = "alchemy-test-cloudtrail-trail";

test.provider(
  "create trail with S3 bucket + policy, update settings and logging, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId, region } = yield* AWSEnvironment.current;
      // Bucket names are globally unique — key ours to the account. The
      // trail ARN is deterministic, so the bucket policy can reference it
      // before the trail exists (no circular dependency).
      const bucketName = `alchemy-test-cloudtrail-logs-${accountId}`;
      const trailArn = `arn:aws:cloudtrail:${region}:${accountId}:trail/${TRAIL_NAME}`;

      const make = (props: {
        isLogging?: boolean;
        includeGlobalServiceEvents?: boolean;
        s3KeyPrefix?: string;
        tags?: Record<string, string>;
        advancedEventSelectors?: TrailAdvancedEventSelector[];
        insightSelectors?: TrailInsightSelector[];
      }) =>
        Effect.gen(function* () {
          const bucket = yield* Bucket("TrailLogs", {
            bucketName,
            forceDestroy: true,
            policy: [
              {
                Effect: "Allow",
                Principal: { Service: "cloudtrail.amazonaws.com" },
                Action: ["s3:GetBucketAcl"],
                Resource: `arn:aws:s3:::${bucketName}`,
                Condition: { StringEquals: { "aws:SourceArn": trailArn } },
              },
              {
                Effect: "Allow",
                Principal: { Service: "cloudtrail.amazonaws.com" },
                Action: ["s3:PutObject"],
                // Cover both the default `AWSLogs/...` path and the
                // `audit/AWSLogs/...` path used after the s3KeyPrefix
                // update below. Still constrained by aws:SourceArn.
                Resource: [
                  `arn:aws:s3:::${bucketName}/AWSLogs/${accountId}/*`,
                  `arn:aws:s3:::${bucketName}/audit/AWSLogs/${accountId}/*`,
                ],
                Condition: {
                  StringEquals: {
                    "s3:x-amz-acl": "bucket-owner-full-control",
                    "aws:SourceArn": trailArn,
                  },
                },
              },
            ],
          });
          const trail = yield* Trail("Audit", {
            trailName: TRAIL_NAME,
            s3BucketName: bucket.bucketName,
            ...props,
          });
          return { trail };
        });

      // 1. Create — logging on by default.
      const { trail } = yield* stack.deploy(
        make({ tags: { fixture: "cloudtrail-trail" } }),
      );
      expect(trail.trailName).toBe(TRAIL_NAME);
      expect(trail.trailArn).toBe(trailArn);
      expect(trail.homeRegion).toBe(region);
      expect(trail.s3BucketName).toBe(bucketName);
      expect(trail.isLogging).toBe(true);

      // Out-of-band verification via distilled.
      const observed = yield* cloudtrail.getTrail({ Name: TRAIL_NAME });
      expect(observed.Trail?.TrailARN).toBe(trailArn);
      expect(observed.Trail?.S3BucketName).toBe(bucketName);
      expect(observed.Trail?.IncludeGlobalServiceEvents).toBe(true);
      expect(observed.Trail?.IsMultiRegionTrail).toBe(false);
      const status = yield* cloudtrail.getTrailStatus({ Name: trailArn });
      expect(status.IsLogging).toBe(true);
      const tags = yield* cloudtrail.listTags({ ResourceIdList: [trailArn] });
      const tagRecord = Object.fromEntries(
        (tags.ResourceTagList?.[0]?.TagsList ?? []).map((t) => [
          t.Key,
          t.Value,
        ]),
      );
      expect(tagRecord.fixture).toBe("cloudtrail-trail");
      expect(tagRecord["alchemy::id"]).toBe("Audit");

      // 2. Sync event + Insights selectors while logging is still on.
      const { trail: withSelectors } = yield* stack.deploy(
        make({
          tags: { fixture: "cloudtrail-trail" },
          advancedEventSelectors: [
            {
              name: "Management events",
              fieldSelectors: [
                { field: "eventCategory", equals: ["Management"] },
              ],
            },
          ],
          insightSelectors: [{ insightType: "ApiCallRateInsight" }],
        }),
      );
      expect(withSelectors.trailArn).toBe(trailArn);
      const selectors = yield* cloudtrail.getEventSelectors({
        TrailName: trailArn,
      });
      expect(selectors.AdvancedEventSelectors?.[0]?.Name).toBe(
        "Management events",
      );
      const insights = yield* cloudtrail.getInsightSelectors({
        TrailName: trailArn,
      });
      expect(
        (insights.InsightSelectors ?? []).map((s) => s.InsightType),
      ).toContain("ApiCallRateInsight");

      // 3. Update in place — stop logging, flip settings, swap tags,
      // disable Insights (`[]`). Omitted event selectors stay untouched.
      const { trail: updated } = yield* stack.deploy(
        make({
          isLogging: false,
          includeGlobalServiceEvents: false,
          s3KeyPrefix: "audit",
          tags: { team: "security" },
          insightSelectors: [],
        }),
      );
      expect(updated.trailArn).toBe(trail.trailArn);
      expect(updated.isLogging).toBe(false);

      const observedAfter = yield* cloudtrail.getTrail({ Name: TRAIL_NAME });
      expect(observedAfter.Trail?.IncludeGlobalServiceEvents).toBe(false);
      expect(observedAfter.Trail?.S3KeyPrefix).toBe("audit");
      const statusAfter = yield* cloudtrail.getTrailStatus({ Name: trailArn });
      expect(statusAfter.IsLogging).toBe(false);
      const tagsAfter = yield* cloudtrail.listTags({
        ResourceIdList: [trailArn],
      });
      const tagRecordAfter = Object.fromEntries(
        (tagsAfter.ResourceTagList?.[0]?.TagsList ?? []).map((t) => [
          t.Key,
          t.Value,
        ]),
      );
      expect(tagRecordAfter.team).toBe("security");
      expect(tagRecordAfter.fixture).toBeUndefined();
      expect(tagRecordAfter["alchemy::id"]).toBe("Audit");

      // Insights disabled: reads back as the typed InsightNotEnabledException
      // (or an empty list, depending on propagation).
      const insightsAfter = yield* cloudtrail
        .getInsightSelectors({ TrailName: trailArn })
        .pipe(
          Effect.map((r) => r.InsightSelectors ?? []),
          Effect.catchTag("InsightNotEnabledException", () =>
            Effect.succeed([] as cloudtrail.InsightSelector[]),
          ),
        );
      expect(insightsAfter).toEqual([]);
      // Omitted event selectors were left untouched by the update.
      const selectorsAfter = yield* cloudtrail.getEventSelectors({
        TrailName: trailArn,
      });
      expect(selectorsAfter.AdvancedEventSelectors?.[0]?.Name).toBe(
        "Management events",
      );

      // 4. Delete — trail deletion is synchronous.
      yield* stack.destroy();
      const gone = yield* Effect.flip(
        cloudtrail.getTrail({ Name: TRAIL_NAME }),
      );
      expect(gone._tag).toBe("TrailNotFoundException");
    }),
  { timeout: 240_000 },
);
