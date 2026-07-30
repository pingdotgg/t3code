import * as AWS from "@/AWS";
import { Detector } from "@/AWS/GuardDuty/Detector.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as guardduty from "@distilled.cloud/aws/guardduty";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeGuardDutyTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
const testLease = makeGuardDutyTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

const firstDetectorId = guardduty
  .listDetectors({})
  .pipe(Effect.map((r) => r.DetectorIds?.[0]));

// The GuardDuty detector is an account/region singleton. This test only runs
// when the account has no detector — it must never disable a detector the user
// already operates (capture-and-restore safety).
test.provider(
  "lifecycle: enable detector, update frequency, disable",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* firstDetectorId;
      if (preexisting) {
        // Refuse to mutate a foreign detector; document and pass.
        yield* Effect.logInfo(
          `GuardDuty detector ${preexisting} already exists — skipping destructive lifecycle test`,
        );
        return;
      }

      yield* stack.destroy();

      // Create — enable with six-hour publishing.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Detector("Detector", {
            enable: true,
            findingPublishingFrequency: "SIX_HOURS",
            tags: { env: "test" },
          });
        }),
      );
      expect(created.detectorId).toBeTruthy();
      expect(created.status).toBe("ENABLED");
      expect(created.findingPublishingFrequency).toBe("SIX_HOURS");

      // Out-of-band verification.
      const live = yield* guardduty.getDetector({
        DetectorId: created.detectorId,
      });
      expect(live.Status).toBe("ENABLED");
      expect(live.FindingPublishingFrequency).toBe("SIX_HOURS");
      expect(live.Tags?.["env"]).toBe("test");
      expect(live.Tags?.["alchemy::id"]).toBe("Detector");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Detector);
      const all = yield* provider.list();
      expect(all.some((d) => d.detectorId === created.detectorId)).toBe(true);

      // Update — change frequency + retag in place (no replacement).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Detector("Detector", {
            enable: true,
            findingPublishingFrequency: "FIFTEEN_MINUTES",
            tags: { env: "prod" },
          });
        }),
      );
      expect(updated.detectorId).toBe(created.detectorId);
      const afterUpdate = yield* guardduty.getDetector({
        DetectorId: created.detectorId,
      });
      expect(afterUpdate.FindingPublishingFrequency).toBe("FIFTEEN_MINUTES");
      expect(afterUpdate.Tags?.["env"]).toBe("prod");

      // Destroy — the detector is deleted and the region is clean again.
      yield* stack.destroy();
      const after = yield* firstDetectorId;
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
