import * as AWS from "@/AWS";
import { ComputeEnvironment } from "@/AWS/Batch/ComputeEnvironment.ts";
import { JobQueue } from "@/AWS/Batch/JobQueue.ts";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { BatchTestNetwork } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

const ceName = "alchemy-test-batch-jq-ce";
const queueName = "alchemy-test-batch-jq";

const describeQueue = batch
  .describeJobQueues({ jobQueues: [queueName] })
  .pipe(
    Effect.map((res) => res.jobQueues?.find((q) => q.status !== "DELETED")),
  );

const describeCe = batch
  .describeComputeEnvironments({ computeEnvironments: [ceName] })
  .pipe(
    Effect.map((res) =>
      res.computeEnvironments?.find((ce) => ce.status !== "DELETED"),
    ),
  );

const chain = (priority?: number) =>
  Effect.gen(function* () {
    const network = yield* BatchTestNetwork;
    const ce = yield* ComputeEnvironment("JqCE", {
      computeEnvironmentName: ceName,
      subnets: network.subnetIds,
      securityGroupIds: network.securityGroupIds,
    });
    return yield* JobQueue("Queue", {
      jobQueueName: queueName,
      computeEnvironments: [ce.computeEnvironmentArn],
      ...(priority !== undefined ? { priority } : {}),
    });
  });

test.provider(
  "chain lifecycle: CE -> queue create, update priority, ordered destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create the CE -> queue chain.
      const deployed = yield* stack.deploy(chain());
      expect(deployed.jobQueueArn).toContain(`job-queue/${queueName}`);

      // Out-of-band verification via distilled.
      const created = yield* describeQueue;
      expect(created?.status).toBe("VALID");
      expect(created?.state).toBe("ENABLED");
      expect(created?.priority).toBe(1);
      expect(
        created?.computeEnvironmentOrder?.[0]?.computeEnvironment,
      ).toContain(`compute-environment/${ceName}`);

      // Update — priority syncs in place.
      yield* stack.deploy(chain(5));
      const updated = yield* describeQueue;
      expect(updated?.priority).toBe(5);
      expect(updated?.status).toBe("VALID");

      // Destroy — queue must fully drain before the CE delete succeeds
      // (exercises the DISABLED -> wait -> delete -> wait-gone path and the
      // CE's ComputeEnvironmentInUse retry window).
      yield* stack.destroy();
      expect(yield* describeQueue).toBeUndefined();
      expect(yield* describeCe).toBeUndefined();
    }),
  { timeout: 240_000 },
);
