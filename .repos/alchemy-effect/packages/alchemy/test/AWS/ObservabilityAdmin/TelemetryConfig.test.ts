import * as AWS from "@/AWS";
import { TelemetryConfig } from "@/AWS/ObservabilityAdmin";
import * as Test from "@/Test/Alchemy";
import * as obs from "@distilled.cloud/aws/observabilityadmin";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeObservabilityAdminTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
const testLease = makeObservabilityAdminTestLease();

beforeAll(testLease.acquire, { timeout: 3_600_000 });
afterAll(testLease.release);

const readStatus = obs
  .getTelemetryEvaluationStatus({})
  .pipe(Effect.map((r) => r.Status ?? "NOT_STARTED"));

const isOn = (status: string) => status === "RUNNING" || status === "STARTING";

// The telemetry config feature is a single account-wide switch shared by
// every test in this account — run sequentially and capture-and-restore.
describe.sequential("AWS.ObservabilityAdmin.TelemetryConfig", () => {
  test.provider(
    "onboards, disables, re-enables, and restores the prior state on destroy",
    (stack) =>
      Effect.gen(function* () {
        // Capture the account's pre-test state out-of-band; every assertion
        // below is relative to it and destroy must restore it.
        const before = yield* readStatus;

        yield* stack.destroy();

        const deployTelemetry = (enabled: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              const telemetry = yield* TelemetryConfig("Telemetry", {
                enabled,
              });
              return {
                status: telemetry.status,
                priorStatus: telemetry.priorStatus,
              };
            }),
          );

        // Onboard.
        const created = yield* deployTelemetry(true);
        expect(created.status).toBe("RUNNING");
        expect(created.priorStatus).toBe(before);
        expect(yield* readStatus).toBe("RUNNING");

        // Disable in place — the singleton is synced, not replaced, and the
        // captured prior status survives the update.
        const disabled = yield* deployTelemetry(false);
        expect(disabled.status).toBe("STOPPED");
        expect(disabled.priorStatus).toBe(before);
        expect(yield* readStatus).toBe("STOPPED");

        // Re-enable.
        const reenabled = yield* deployTelemetry(true);
        expect(reenabled.status).toBe("RUNNING");
        expect(yield* readStatus).toBe("RUNNING");

        // Destroy restores the captured pre-test state: an account that was
        // already onboarded stays RUNNING; otherwise the feature is stopped.
        yield* stack.destroy();
        const after = yield* readStatus;
        if (isOn(before)) {
          expect(after).toBe("RUNNING");
        } else {
          expect(["STOPPED", "NOT_STARTED"]).toContain(after);
        }
      }),
    { timeout: 180_000 },
  );
});
