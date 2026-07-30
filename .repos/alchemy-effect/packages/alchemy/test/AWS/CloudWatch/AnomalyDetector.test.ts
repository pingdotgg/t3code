import { AnomalyDetector } from "@/AWS/CloudWatch";
import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `list()` enumerates every CloudWatch anomaly detector in the account/region
// via the paginated `cloudwatch.describeAnomalyDetectors` op. Deploy a real
// single-metric detector, resolve the provider from context via the typed
// `findProvider`, call `list()`, and assert the deployed detector appears in the
// exhaustively paginated result (matched by its stable `detectorId` identity).
test.provider(
  "list enumerates the deployed anomaly detector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const detector = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AnomalyDetector("ListAnomalyDetector", {
            Namespace: "AWS/Lambda",
            MetricName: "Errors",
            Stat: "Sum",
            Dimensions: [
              { Name: "FunctionName", Value: "alchemy-test-anomaly-list" },
            ],
          });
        }),
      );

      const provider = yield* Provider.findProvider(AnomalyDetector);
      const all = yield* provider.list();

      expect(all.some((d) => d.detectorId === detector.detectorId)).toBe(true);

      yield* stack.destroy();

      // Out-of-band assert-gone: the exhaustively-paginated live listing no
      // longer contains the detector after the final destroy.
      const after = yield* provider.list();
      expect(after.some((d) => d.detectorId === detector.detectorId)).toBe(
        false,
      );
    }),
  { timeout: 240_000 },
);
