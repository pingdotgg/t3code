import * as AWS from "@/AWS";
import { Keyspace } from "@/AWS/Keyspaces";
import * as Test from "@/Test/Alchemy";
import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getKeyspace = (name: string) =>
  keyspaces
    .getKeyspace({ keyspaceName: name })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const getTags = (arn: string) =>
  keyspaces
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.map((r) => r.tags ?? []));

test.provider(
  "create, update tags, delete Keyspaces keyspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Keyspace("AppData", {
            keyspaceName: "alchemy_ks_test",
            tags: { team: "platform" },
          });
        }),
      );

      expect(created.keyspaceName).toEqual("alchemy_ks_test");
      expect(created.keyspaceArn).toContain("keyspace/alchemy_ks_test");

      // out-of-band verification
      const observed = yield* getKeyspace(created.keyspaceName);
      expect(observed?.keyspaceName).toEqual("alchemy_ks_test");

      const tags = yield* getTags(created.keyspaceArn);
      const tagMap = Object.fromEntries(tags.map((t) => [t.key, t.value]));
      expect(tagMap.team).toEqual("platform");
      expect(tagMap["alchemy::id"]).toBeDefined();

      // update tags
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Keyspace("AppData", {
            keyspaceName: "alchemy_ks_test",
            tags: { team: "data" },
          });
        }),
      );
      const reTags = yield* getTags(created.keyspaceArn);
      const reMap = Object.fromEntries(reTags.map((t) => [t.key, t.value]));
      expect(reMap.team).toEqual("data");

      // delete
      yield* stack.destroy();
      const gone = yield* getKeyspace(created.keyspaceName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 180_000 },
);
