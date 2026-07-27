import * as AWS from "@/AWS";
import { KeyValueStore } from "@/AWS/CloudFront";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.CloudFront.KeyValueStore", () => {
  test.provider(
    "list enumerates the deployed key value store",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* KeyValueStore("ListKeyValueStore", {
              comment: "list",
            });
          }),
        );

        const provider = yield* Provider.findProvider(KeyValueStore);
        const all = yield* provider.list();

        expect(
          all.some((s) => s.keyValueStoreId === deployed.keyValueStoreId),
        ).toBe(true);

        yield* stack.destroy();
        yield* assertKeyValueStoreDeleted(deployed.keyValueStoreName);
      }),
    { timeout: 300_000 },
  );
});

const assertKeyValueStoreDeleted = (name: string) =>
  cloudfront.describeKeyValueStore({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("KeyValueStoreStillExists"))),
    Effect.catchTag("EntityNotFound", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "KeyValueStoreStillExists",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );
