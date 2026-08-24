import * as AWS from "@/AWS";
import { ServiceIntegration } from "@/AWS/DevOpsGuru/ServiceIntegration.ts";
import * as Test from "@/Test/Alchemy";
import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Observe the account's integration out-of-band. Absent sections/statuses
// mean the account default (disabled / AWS-owned key).
const observed = devopsguru.describeServiceIntegration({}).pipe(
  Effect.map(({ ServiceIntegration: config }) => ({
    opsCenter: config?.OpsCenter?.OptInStatus === "ENABLED",
    logsAnomalyDetection:
      config?.LogsAnomalyDetection?.OptInStatus === "ENABLED",
    encryptionType:
      config?.KMSServerSideEncryption?.Type ?? "AWS_OWNED_KMS_KEY",
  })),
);

// Ungated typed probe: describeServiceIntegration always answers with the
// typed response shape — never an untyped catch-all.
test.provider("describeServiceIntegration returns typed results", () =>
  Effect.gen(function* () {
    const config = yield* observed;
    expect(typeof config.opsCenter).toBe("boolean");
    expect(typeof config.logsAnomalyDetection).toBe("boolean");
  }),
);

// The integration is an account/region singleton. This test only runs when
// the account is at the defaults — it must never clobber a configuration
// the user already operates.
test.provider(
  "lifecycle: enable log anomaly detection, add OpsCenter, restore defaults",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* observed;
      if (
        preexisting.opsCenter ||
        preexisting.logsAnomalyDetection ||
        preexisting.encryptionType !== "AWS_OWNED_KMS_KEY"
      ) {
        yield* Effect.logInfo(
          "DevOps Guru service integration already configured — skipping destructive lifecycle test",
        );
        return;
      }

      yield* stack.destroy();

      // Create — enable log anomaly detection only.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ServiceIntegration("Integration", {
            logsAnomalyDetection: true,
          });
        }),
      );
      expect(created.logsAnomalyDetection).toBe(true);
      expect(created.opsCenter).toBe(false);
      expect(created.encryptionType).toBe("AWS_OWNED_KMS_KEY");

      // Out-of-band verification via distilled.
      const afterCreate = yield* observed;
      expect(afterCreate.logsAnomalyDetection).toBe(true);
      expect(afterCreate.opsCenter).toBe(false);

      // Update — enable OpsCenter too; only the drifted section is updated.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ServiceIntegration("Integration", {
            logsAnomalyDetection: true,
            opsCenter: true,
          });
        }),
      );
      expect(updated.logsAnomalyDetection).toBe(true);
      expect(updated.opsCenter).toBe(true);
      const afterUpdate = yield* observed;
      expect(afterUpdate.opsCenter).toBe(true);

      // Destroy — the account defaults are restored.
      yield* stack.destroy();
      const after = yield* observed;
      expect(after.opsCenter).toBe(false);
      expect(after.logsAnomalyDetection).toBe(false);
      expect(after.encryptionType).toBe("AWS_OWNED_KMS_KEY");
    }),
  { timeout: 180_000 },
);
