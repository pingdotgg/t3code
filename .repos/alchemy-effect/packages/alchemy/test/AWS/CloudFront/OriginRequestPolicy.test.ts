import * as AWS from "@/AWS";
import { OriginRequestPolicy } from "@/AWS/CloudFront";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

describe("AWS.CloudFront.OriginRequestPolicy", () => {
  test.provider.skipIf(!runLive)(
    "create, update, and delete an origin request policy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* OriginRequestPolicy("AppOriginRequest", {
              comment: "initial",
              headersConfig: {
                HeaderBehavior: "whitelist",
                Headers: { Quantity: 1, Items: ["Authorization"] },
              },
              cookiesConfig: { CookieBehavior: "none" },
              queryStringsConfig: { QueryStringBehavior: "all" },
            });
          }),
        );

        const initial = yield* cloudfront.getOriginRequestPolicy({
          Id: created.originRequestPolicyId,
        });
        expect(initial.OriginRequestPolicy?.Id).toEqual(
          created.originRequestPolicyId,
        );
        expect(
          initial.OriginRequestPolicy?.OriginRequestPolicyConfig?.Comment,
        ).toEqual("initial");
        expect(
          initial.OriginRequestPolicy?.OriginRequestPolicyConfig?.HeadersConfig
            ?.Headers?.Items,
        ).toEqual(["Authorization"]);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* OriginRequestPolicy("AppOriginRequest", {
              comment: "updated",
              headersConfig: {
                HeaderBehavior: "whitelist",
                Headers: {
                  Quantity: 2,
                  Items: ["Authorization", "Accept-Language"],
                },
              },
              cookiesConfig: { CookieBehavior: "all" },
              queryStringsConfig: { QueryStringBehavior: "all" },
            });
          }),
        );

        expect(updated.originRequestPolicyId).toEqual(
          created.originRequestPolicyId,
        );

        const after = yield* cloudfront.getOriginRequestPolicy({
          Id: updated.originRequestPolicyId,
        });
        expect(
          after.OriginRequestPolicy?.OriginRequestPolicyConfig?.Comment,
        ).toEqual("updated");
        expect(
          after.OriginRequestPolicy?.OriginRequestPolicyConfig?.HeadersConfig
            ?.Headers?.Items,
        ).toEqual(["Authorization", "Accept-Language"]);
        expect(
          after.OriginRequestPolicy?.OriginRequestPolicyConfig?.CookiesConfig
            ?.CookieBehavior,
        ).toEqual("all");

        yield* stack.destroy();
        yield* assertOriginRequestPolicyDeleted(updated.originRequestPolicyId);
      }),
    300_000,
  );
});

const assertOriginRequestPolicyDeleted = (id: string) =>
  cloudfront.getOriginRequestPolicy({ Id: id }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error("OriginRequestPolicyStillExists")),
    ),
    Effect.catchTag("NoSuchOriginRequestPolicy", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error &&
        error.message === "OriginRequestPolicyStillExists",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(24)),
      ),
    }),
  );
