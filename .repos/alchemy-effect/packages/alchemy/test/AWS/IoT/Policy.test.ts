import * as AWS from "@/AWS";
import { Policy } from "@/AWS/IoT";
import * as Test from "@/Test/Alchemy";
import * as iot from "@distilled.cloud/aws/iot";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertPolicyGone = (policyName: string) =>
  iot.getPolicy({ policyName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`policy ${policyName} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe.sequential("AWS.IoT.Policy", () => {
  test.provider(
    "creates a policy, updates the document to a new default version, and deletes it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const policy = yield* Policy("DevicePolicy", {
              policyDocument: {
                Version: "2012-10-17",
                Statement: [
                  { Effect: "Allow", Action: "iot:Connect", Resource: "*" },
                ],
              },
            });
            return { policyName: policy.policyName };
          }),
        );

        const observed = yield* iot.getPolicy({
          policyName: created.policyName,
        });
        expect(observed.policyDocument).toContain("iot:Connect");
        const firstVersion = observed.defaultVersionId;

        // Update the document — creates a new default version.
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* Policy("DevicePolicy", {
              policyDocument: {
                Version: "2012-10-17",
                Statement: [
                  { Effect: "Allow", Action: "iot:Connect", Resource: "*" },
                  { Effect: "Allow", Action: "iot:Publish", Resource: "*" },
                ],
              },
            });
          }),
        );
        const updated = yield* iot.getPolicy({
          policyName: created.policyName,
        });
        expect(updated.policyDocument).toContain("iot:Publish");
        expect(updated.defaultVersionId).not.toEqual(firstVersion);

        yield* stack.destroy();
        yield* assertPolicyGone(created.policyName);
      }),
    { timeout: 180_000 },
  );
});
