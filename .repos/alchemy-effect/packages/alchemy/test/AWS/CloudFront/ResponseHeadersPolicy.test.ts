import * as AWS from "@/AWS";
import { ResponseHeadersPolicy } from "@/AWS/CloudFront";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.CloudFront.ResponseHeadersPolicy", () => {
  test.provider(
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

        // Control-plane reads are eventually consistent — poll until the
        // update is visible, then assert.
        const after = yield* cloudfront
          .getResponseHeadersPolicy({ Id: updated.responseHeadersPolicyId })
          .pipe(
            Effect.repeat({
              schedule: Schedule.fixed("2 seconds"),
              until: (r) =>
                r.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig
                  ?.Comment === "updated",
              times: 15,
            }),
          );
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

  test.provider(
    "list enumerates the deployed response headers policy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ResponseHeadersPolicy("ListResponseHeaders", {
              comment: "list",
              securityHeadersConfig: {
                ContentTypeOptions: { Override: true },
              },
            });
          }),
        );

        const provider = yield* Provider.findProvider(ResponseHeadersPolicy);
        const all = yield* provider.list();

        expect(
          all.some(
            (p) =>
              p.responseHeadersPolicyId === deployed.responseHeadersPolicyId,
          ),
        ).toBe(true);

        yield* stack.destroy();
        yield* assertResponseHeadersPolicyDeleted(
          deployed.responseHeadersPolicyId,
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
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );
