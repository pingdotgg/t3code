import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: GCP.providers() });

const gone = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
) =>
  self.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
  );

test.provider(
  "renaming a topic or bucket replaces it and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const deploy = (suffix: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const topic = yield* GCP.PubSub.Topic("Renamed", {
              topicId: `alchemy-rename-${suffix}`,
            });
            const bucket = yield* GCP.Storage.Bucket("RenamedBucket", {
              bucketName: `alchemy-rename-${project}-${suffix}`,
              forceDestroy: true,
            });
            return { topic: topic.name, bucket: bucket.bucketName };
          }),
        );
      const first = yield* deploy("a");
      const second = yield* deploy("b");
      expect(second.topic).not.toEqual(first.topic);
      expect(second.bucket).not.toEqual(first.bucket);
      expect(
        yield* gone(pubsub.getProjectsTopics({ topic: first.topic })),
      ).toEqual("gone");
      expect(yield* gone(storage.getBuckets({ bucket: first.bucket }))).toEqual(
        "gone",
      );
      expect(
        yield* gone(pubsub.getProjectsTopics({ topic: second.topic })),
      ).toEqual("found");
      yield* stack.destroy();
    }),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 180_000 },
);
