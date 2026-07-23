import * as AWS from "@/AWS";
import { ResponseHeadersPolicy } from "@/AWS/CloudFront";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

describe("AWS.CloudFront.ResponseHeadersPolicy", () => {
  test.provider.skipIf(!runLive)(
    "create, update, and delete a response headers policy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ResponseHeadersPolicy("AppResponseHeaders", {
              comment: "initial",
              securityHeadersConfig: {
                StrictTransportSecurity: {
                  AccessControlMaxAgeSec: 31536000,
                  IncludeSubdomains: true,
                  Preload: true,
                  Override: true,
                },
                ContentTypeOptions: { Override: true },
                FrameOptions: { FrameOption: "DENY", Override: true },
                ReferrerPolicy: {
                  ReferrerPolicy: "no-referrer",
                  Override: true,
                },
              },
            });
          }),
        );

        const initial = yield* cloudfront.getResponseHeadersPolicy({
          Id: created.responseHeadersPolicyId,
        });
        expect(initial.ResponseHeadersPolicy?.Id).toEqual(
          created.responseHeadersPolicyId,
        );
        expect(
          initial.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Comment,
        ).toEqual("initial");
        expect(
          initial.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig
            ?.SecurityHeadersConfig?.FrameOptions?.FrameOption,
        ).toEqual("DENY");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ResponseHeadersPolicy("AppResponseHeaders", {
              comment: "updated",
              corsConfig: {
                AccessControlAllowOrigins: {
                  Quantity: 1,
                  Items: ["https://app.example.com"],
                },
                AccessControlAllowMethods: {
                  Quantity: 2,
                  Items: ["GET", "OPTIONS"],
                },
                AccessControlAllowHeaders: {
                  Quantity: 1,
                  Items: ["Authorization"],
                },
                AccessControlAllowCredentials: false,
                OriginOverride: true,
              },
              securityHeadersConfig: {
                FrameOptions: { FrameOption: "SAMEORIGIN", Override: true },
              },
            });
          }),
        );

        expect(updated.responseHeadersPolicyId).toEqual(
          created.responseHeadersPolicyId,
        );

        const after = yield* cloudfront.getResponseHeadersPolicy({
          Id: updated.responseHeadersPolicyId,
        });
        expect(
          after.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Comment,
        ).toEqual("updated");
        expect(
          after.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig
            ?.SecurityHeadersConfig?.FrameOptions?.FrameOption,
        ).toEqual("SAMEORIGIN");
        expect(
          after.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.CorsConfig
            ?.AccessControlAllowOrigins?.Items,
        ).toEqual(["https://app.example.com"]);

        yield* stack.destroy();
        yield* assertResponseHeadersPolicyDeleted(
          updated.responseHeadersPolicyId,
        );
      }),
    { timeout: 300_000 },
  );
});

const assertResponseHeadersPolicyDeleted = (id: string) =>
  cloudfront.getResponseHeadersPolicy({ Id: id }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error("ResponseHeadersPolicyStillExists")),
    ),
    Effect.catchTag("NoSuchResponseHeadersPolicy", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error &&
        error.message === "ResponseHeadersPolicyStillExists",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(24)),
      ),
    }),
  );
