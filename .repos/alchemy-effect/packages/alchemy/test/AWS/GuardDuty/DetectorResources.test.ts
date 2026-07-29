import * as AWS from "@/AWS";
import { Detector } from "@/AWS/GuardDuty/Detector.ts";
import { Filter } from "@/AWS/GuardDuty/Filter.ts";
import { IPSet } from "@/AWS/GuardDuty/IPSet.ts";
import { ThreatIntelSet } from "@/AWS/GuardDuty/ThreatIntelSet.ts";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import * as Test from "@/Test/Alchemy";
import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeGuardDutyTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
const testLease = makeGuardDutyTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

const TRUSTED_KEY = "trusted-ips.txt";
const THREAT_KEY = "threat-ips.txt";

// One aggregate lifecycle test: the three detector-scoped resources share a
// detector (an account/region singleton) and the two S3-hosted lists share a
// bucket, so provisioning them together keeps the suite fast and mirrors how
// they are deployed in practice.
test.provider(
  "lifecycle: filter, trusted IP set, and threat intel set on one detector",
  (stack) =>
    Effect.gen(function* () {
      // The GuardDuty detector is an account/region singleton — never touch
      // one this test did not create (capture-and-restore safety).
      const preexisting = (yield* guardduty.listDetectors({})).DetectorIds?.[0];
      if (preexisting) {
        yield* Effect.logInfo(
          `GuardDuty detector ${preexisting} already exists — skipping detector-scoped resource test`,
        );
        return;
      }

      yield* stack.destroy();

      // Phase 1 — the bucket hosting both lists must exist (with objects)
      // before GuardDuty is pointed at it.
      const phase1 = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ListsBucket", { forceDestroy: true });
          return { bucketName: bucket.bucketName };
        }),
      );
      yield* s3.putObject({
        Bucket: phase1.bucketName,
        Key: TRUSTED_KEY,
        Body: "203.0.113.10\n203.0.113.11\n",
      });
      yield* s3.putObject({
        Bucket: phase1.bucketName,
        Key: THREAT_KEY,
        Body: "198.51.100.20\n198.51.100.21\n",
      });

      // Phase 2 — detector + the three detector-scoped resources.
      const deploy = (filterProps: {
        action: "NOOP" | "ARCHIVE";
        rank: number;
        description: string;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            // Keep the bucket deployed across phases; its physical name is
            // already resolved from phase 1.
            yield* Bucket("ListsBucket", { forceDestroy: true });
            const detector = yield* Detector("Detector", {
              findingPublishingFrequency: "SIX_HOURS",
              tags: { fixture: "guardduty-detector-resources" },
            });
            const filter = yield* Filter("HighSeverity", {
              detectorId: detector.detectorId,
              description: filterProps.description,
              action: filterProps.action,
              rank: filterProps.rank,
              findingCriteria: { Criterion: { severity: { Gte: 7 } } },
              tags: { env: "test" },
            });
            const ipSet = yield* IPSet("TrustedIPs", {
              detectorId: detector.detectorId,
              format: "TXT",
              location: `https://s3.amazonaws.com/${phase1.bucketName}/${TRUSTED_KEY}`,
              activate: true,
            });
            const threatSet = yield* ThreatIntelSet("ThreatIPs", {
              detectorId: detector.detectorId,
              format: "TXT",
              location: `https://s3.amazonaws.com/${phase1.bucketName}/${THREAT_KEY}`,
              activate: false,
            });
            return {
              detectorId: detector.detectorId,
              filterName: filter.name,
              filterAction: filter.action,
              filterRank: filter.rank,
              ipSetId: ipSet.ipSetId,
              ipSetStatus: ipSet.status,
              threatIntelSetId: threatSet.threatIntelSetId,
              threatIntelSetStatus: threatSet.status,
            };
          }),
        );

      const created = yield* deploy({
        action: "NOOP",
        rank: 1,
        description: "keep high severity findings visible",
      });
      expect(created.detectorId).toBeTruthy();
      expect(created.filterAction).toBe("NOOP");
      expect(created.filterRank).toBe(1);
      expect(["ACTIVE", "ACTIVATING"]).toContain(created.ipSetStatus);
      expect(created.threatIntelSetStatus).toBe("INACTIVE");

      // Out-of-band verification.
      const liveFilter = yield* guardduty.getFilter({
        DetectorId: created.detectorId,
        FilterName: created.filterName,
      });
      expect(liveFilter.Action).toBe("NOOP");
      expect(liveFilter.Tags?.["env"]).toBe("test");
      expect(liveFilter.Tags?.["alchemy::id"]).toBe("HighSeverity");

      const liveIpSet = yield* guardduty.getIPSet({
        DetectorId: created.detectorId,
        IpSetId: created.ipSetId,
      });
      expect(liveIpSet.Format).toBe("TXT");
      expect(liveIpSet.Location).toContain(TRUSTED_KEY);

      const liveThreatSet = yield* guardduty.getThreatIntelSet({
        DetectorId: created.detectorId,
        ThreatIntelSetId: created.threatIntelSetId,
      });
      expect(liveThreatSet.Format).toBe("TXT");
      expect(liveThreatSet.Location).toContain(THREAT_KEY);

      // Update — flip the filter to auto-archive in place (no replacement).
      // Rank stays 1: GuardDuty bounds rank by the number of filters on the
      // detector, so a lone filter can only ever hold rank 1.
      const updated = yield* deploy({
        action: "ARCHIVE",
        rank: 1,
        description: "auto-archive high severity findings",
      });
      expect(updated.detectorId).toBe(created.detectorId);
      expect(updated.filterName).toBe(created.filterName);
      expect(updated.ipSetId).toBe(created.ipSetId);
      expect(updated.threatIntelSetId).toBe(created.threatIntelSetId);

      const afterUpdate = yield* guardduty.getFilter({
        DetectorId: created.detectorId,
        FilterName: created.filterName,
      });
      expect(afterUpdate.Action).toBe("ARCHIVE");
      expect(afterUpdate.Rank).toBe(1);
      expect(afterUpdate.Description).toBe(
        "auto-archive high severity findings",
      );

      // Destroy — everything (including the detector singleton) is gone.
      yield* stack.destroy();
      const after = yield* guardduty.listDetectors({});
      expect(after.DetectorIds ?? []).toHaveLength(0);
    }),
  { timeout: 240_000 },
);
