import * as AWS from "@alchemy.run/aws";
import { OriginAccessControl } from "@alchemy.run/aws/CloudFront";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe(
  "AWS.CloudFront.OriginAccessControl",
  { tags: ["provider:aws", "provider:aws:cloudfront", "live"] },
  () => {
    test.provider(
      "list enumerates the deployed origin access control",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* OriginAccessControl("ListOriginAccessControl", {
                description: "list",
                originType: "s3",
              });
            }),
          );

          const provider = yield* Provider.findProvider(OriginAccessControl);
          const all = yield* provider.list();

          expect(all.some((o) => o.originAccessControlId === deployed.originAccessControlId)).toBe(
            true,
          );

          yield* stack.destroy();
          yield* assertOriginAccessControlDeleted(deployed.originAccessControlId);
        }),
      { timeout: 300_000 },
    );
  },
);

const assertOriginAccessControlDeleted = (id: string) =>
  cloudfront.getOriginAccessControlConfig({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("OriginAccessControlStillExists"))),
    Effect.catchTag("NoSuchOriginAccessControl", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "OriginAccessControlStillExists",
      schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
    }),
  );
