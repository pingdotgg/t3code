import * as AWS from "@/AWS";
import { ScalableTarget } from "@/AWS/ApplicationAutoScaling";
import { Table } from "@/AWS/DynamoDB";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const describeTarget = (
  resourceId: string,
  scalableDimension: aas.ScalableDimension,
) =>
  aas
    .describeScalableTargets({
      ServiceNamespace: "dynamodb",
      ResourceIds: [resourceId],
      ScalableDimension: scalableDimension,
    })
    .pipe(
      Effect.map((res) =>
        res.ScalableTargets?.find(
          (t) =>
            t.ResourceId === resourceId &&
            t.ScalableDimension === scalableDimension,
        ),
      ),
    );

const waitUntilTargetGone = (
  resourceId: string,
  scalableDimension: aas.ScalableDimension,
) =>
  describeTarget(resourceId, scalableDimension).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (target) => target === undefined,
      times: 10,
    }),
  );

// Full lifecycle against a provisioned DynamoDB table (tables are near-instant
// and free at 1 RCU/WCU): register a read-capacity scalable target with tags,
// update min/max + tags in place (same ARN), replace by switching the
// scalable dimension, then destroy and verify deregistration out-of-band.
test.provider(
  "dynamodb read-capacity target: register, update in place, replace on dimension change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: {
        scalableDimension: aas.ScalableDimension;
        maxCapacity: number;
        tags: Record<string, string>;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const table = yield* Table("AasTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              billingMode: "PROVISIONED",
              provisionedThroughput: {
                ReadCapacityUnits: 1,
                WriteCapacityUnits: 1,
              },
            });
            const target = yield* ScalableTarget("AasTarget", {
              serviceNamespace: "dynamodb",
              resourceId: Output.interpolate`table/${table.tableName}`,
              scalableDimension: props.scalableDimension,
              minCapacity: 1,
              maxCapacity: props.maxCapacity,
              tags: props.tags,
            });
            return {
              tableName: table.tableName.as<string>(),
              resourceId: target.resourceId.as<string>(),
              scalableTargetArn: target.scalableTargetArn.as<string>(),
              minCapacity: target.minCapacity.as<number>(),
              maxCapacity: target.maxCapacity.as<number>(),
            };
          }),
        );

      // Create.
      const created = yield* deploy({
        scalableDimension: "dynamodb:table:ReadCapacityUnits",
        maxCapacity: 5,
        tags: { env: "test", keep: "v1" },
      });
      expect(created.resourceId).toEqual(`table/${created.tableName}`);
      expect(created.scalableTargetArn).toContain("scalable-target/");
      expect(created.minCapacity).toBe(1);
      expect(created.maxCapacity).toBe(5);

      // Out-of-band: the target is registered with the requested capacity
      // range and carries both the internal alchemy tags and the user tags.
      const observed = yield* describeTarget(
        created.resourceId,
        "dynamodb:table:ReadCapacityUnits",
      );
      expect(observed?.MinCapacity).toBe(1);
      expect(observed?.MaxCapacity).toBe(5);
      const tags = yield* aas.listTagsForResource({
        ResourceARN: created.scalableTargetArn,
      });
      expect(tags.Tags?.["alchemy::id"]).toBe("AasTarget");
      expect(tags.Tags?.env).toBe("test");
      expect(tags.Tags?.keep).toBe("v1");

      // Update in place — capacity range and tags are mutable; the identity
      // triple (and thus the ARN) is stable.
      const updated = yield* deploy({
        scalableDimension: "dynamodb:table:ReadCapacityUnits",
        maxCapacity: 6,
        tags: { env: "test", added: "new" },
      });
      expect(updated.scalableTargetArn).toEqual(created.scalableTargetArn);
      expect(updated.maxCapacity).toBe(6);
      const observedAfterUpdate = yield* describeTarget(
        created.resourceId,
        "dynamodb:table:ReadCapacityUnits",
      );
      expect(observedAfterUpdate?.MaxCapacity).toBe(6);
      const tagsAfterUpdate = yield* aas.listTagsForResource({
        ResourceARN: created.scalableTargetArn,
      });
      expect(tagsAfterUpdate.Tags?.added).toBe("new");
      expect(tagsAfterUpdate.Tags?.keep).toBeUndefined();
      expect(tagsAfterUpdate.Tags?.["alchemy::id"]).toBe("AasTarget");

      // Replace — the scalable dimension is part of the identity triple.
      const replaced = yield* deploy({
        scalableDimension: "dynamodb:table:WriteCapacityUnits",
        maxCapacity: 6,
        tags: { env: "test" },
      });
      expect(replaced.scalableTargetArn).not.toEqual(created.scalableTargetArn);
      const writeTarget = yield* describeTarget(
        created.resourceId,
        "dynamodb:table:WriteCapacityUnits",
      );
      expect(writeTarget?.MaxCapacity).toBe(6);
      const readTargetGone = yield* waitUntilTargetGone(
        created.resourceId,
        "dynamodb:table:ReadCapacityUnits",
      );
      expect(readTargetGone).toBeUndefined();

      // Destroy — the target deregisters.
      yield* stack.destroy();
      const gone = yield* waitUntilTargetGone(
        created.resourceId,
        "dynamodb:table:WriteCapacityUnits",
      );
      expect(gone).toBeUndefined();
    }),
  { timeout: 240_000 },
);
