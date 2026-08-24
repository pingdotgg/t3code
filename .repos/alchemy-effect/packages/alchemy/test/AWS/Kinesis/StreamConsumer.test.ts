import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.Kinesis.StreamConsumer", () => {
  test.provider(
    "create, update tags, and delete a stream consumer",
    (stack) =>
      Effect.gen(function* () {
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const stream = yield* AWS.Kinesis.Stream("ConsumerSourceStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });

            const consumer = yield* AWS.Kinesis.StreamConsumer(
              "AnalyticsConsumer",
              {
                streamArn: stream.streamArn,
                tags: {
                  fixture: "consumer-test",
                },
              },
            );

            return { stream, consumer };
          }),
        );

        const description = yield* Kinesis.describeStreamConsumer({
          ConsumerARN: deployed.consumer.consumerArn,
        });
        expect(description.ConsumerDescription.ConsumerStatus).toEqual(
          "ACTIVE",
        );

        const initialTags = yield* Kinesis.listTagsForResource({
          ResourceARN: deployed.consumer.consumerArn,
        });
        expect(initialTags.Tags).toContainEqual({
          Key: "fixture",
          Value: "consumer-test",
        });

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const stream = yield* AWS.Kinesis.Stream("ConsumerSourceStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });

            const consumer = yield* AWS.Kinesis.StreamConsumer(
              "AnalyticsConsumer",
              {
                streamArn: stream.streamArn,
                tags: {
                  fixture: "consumer-test-updated",
                  team: "platform",
                },
              },
            );

            return { stream, consumer };
          }),
        );

        const updatedTags = yield* Kinesis.listTagsForResource({
          ResourceARN: updated.consumer.consumerArn,
        });
        expect(updatedTags.Tags).toContainEqual({
          Key: "fixture",
          Value: "consumer-test-updated",
        });
        expect(updatedTags.Tags).toContainEqual({
          Key: "team",
          Value: "platform",
        });

        yield* stack.destroy();

        const deleted = yield* Kinesis.describeStreamConsumer({
          ConsumerARN: updated.consumer.consumerArn,
        }).pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
        expect(deleted).toBe(true);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "list enumerates the deployed stream consumer",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const stream = yield* AWS.Kinesis.Stream("ListConsumerStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });

            const consumer = yield* AWS.Kinesis.StreamConsumer("ListConsumer", {
              streamArn: stream.streamArn,
            });

            return { stream, consumer };
          }),
        );

        const provider = yield* Provider.findProvider(
          AWS.Kinesis.StreamConsumer,
        );
        const all = yield* provider.list();

        expect(
          all.some((c) => c.consumerArn === deployed.consumer.consumerArn),
        ).toBe(true);

        yield* stack.destroy();
      }),
    { timeout: 180_000 },
  );
});
