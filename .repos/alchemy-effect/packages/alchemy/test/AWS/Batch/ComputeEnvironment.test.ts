import * as AWS from "@/AWS";
import { ComputeEnvironment } from "@/AWS/Batch/ComputeEnvironment.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { BatchTestNetwork } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

const ceName = "alchemy-test-batch-ce-lifecycle";

const describeCe = batch
  .describeComputeEnvironments({ computeEnvironments: [ceName] })
  .pipe(
    Effect.map((res) =>
      res.computeEnvironments?.find((ce) => ce.status !== "DELETED"),
    ),
  );

test.provider(
  "lifecycle: create with stack-owned networking, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with a stack-owned network. Creating an ambient default VPC
      // leaves AWS-generated resources outside this stack's state.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* BatchTestNetwork;
          return yield* ComputeEnvironment("LifecycleCE", {
            computeEnvironmentName: ceName,
            subnets: network.subnetIds,
            securityGroupIds: network.securityGroupIds,
          });
        }),
      );
      expect(deployed.computeEnvironmentArn).toContain(
        `compute-environment/${ceName}`,
      );

      // Out-of-band verification via distilled.
      const created = yield* describeCe;
      expect(created?.type).toBe("MANAGED");
      expect(created?.status).toBe("VALID");
      expect(created?.state).toBe("ENABLED");
      expect(created?.computeResources?.type).toBe("FARGATE");
      expect(created?.computeResources?.maxvCpus).toBe(4);
      expect(created?.computeResources?.subnets?.length).toBeGreaterThan(0);
      expect(
        created?.computeResources?.securityGroupIds?.length,
      ).toBeGreaterThan(0);

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(ComputeEnvironment);
      const all = yield* provider.list();
      expect(all.some((ce) => ce.computeEnvironmentName === ceName)).toBe(true);

      // Update — maxvCpus and state sync in place (no replacement).
      yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* BatchTestNetwork;
          return yield* ComputeEnvironment("LifecycleCE", {
            computeEnvironmentName: ceName,
            maxvCpus: 8,
            state: "DISABLED",
            subnets: network.subnetIds,
            securityGroupIds: network.securityGroupIds,
          });
        }),
      );
      const updated = yield* describeCe;
      expect(updated?.computeResources?.maxvCpus).toBe(8);
      expect(updated?.state).toBe("DISABLED");
      expect(updated?.status).toBe("VALID");

      // Destroy — provider disables, deletes, and waits until gone.
      yield* stack.destroy();
      const after = yield* describeCe;
      expect(after).toBeUndefined();
    }),
  { timeout: 240_000 },
);
