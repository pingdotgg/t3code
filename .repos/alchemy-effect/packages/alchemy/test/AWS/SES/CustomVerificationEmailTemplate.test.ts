import * as AWS from "@/AWS";
import { CustomVerificationEmailTemplate } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// SES rejects CreateCustomVerificationEmailTemplate outright when its
// FromEmailAddress is not already a verified identity ("NotFoundException: The
// from email address <...> is not verified"), so the whole suite needs a
// verified sender. Point AWS_TEST_SES_FROM at one to run it. Sending through a
// template additionally requires production (out-of-sandbox) access.
const VERIFIED_FROM = process.env.AWS_TEST_SES_FROM;
const FROM = VERIFIED_FROM ?? "verify@alchemy-test.example.com";

class CvetStillExists extends Data.TaggedError("CvetStillExists")<{
  readonly name: string;
}> {}

const assertCvetDeleted = (name: string) =>
  sesv2.getCustomVerificationEmailTemplate({ TemplateName: name }).pipe(
    Effect.flatMap(() => Effect.fail(new CvetStillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CvetStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// UNGATED probe. Both lifecycle tests below need a verified sender, so on a
// bare account this file would otherwise assert nothing at all. This proves
// the gate itself is real and correctly typed: SES refuses to create the
// template when its FromEmailAddress is unverified, and distilled surfaces
// that as NotFoundException rather than an untyped catch-all. If AWS ever
// changes the rejection, this fails instead of silently skipping forever.
test.provider(
  "creating a template from an unverified sender fails with the typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* CustomVerificationEmailTemplate("UnverifiedProbe", {
              fromEmailAddress: "definitely-not-verified@alchemy-test.invalid",
              templateSubject: "Please confirm your email",
              templateContent:
                "<html><body>Click to verify your address.</body></html>",
              successRedirectionURL: "https://example.com/verified",
              failureRedirectionURL: "https://example.com/verify-failed",
            });
          }),
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(JSON.stringify(result.failure)).toContain("NotFoundException");
      }

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!VERIFIED_FROM)(
  "custom verification template lifecycle: create, update, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const template = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Verify", {
            fromEmailAddress: FROM,
            templateSubject: "Please confirm your email",
            templateContent:
              "<html><body>Click to verify your address.</body></html>",
            successRedirectionURL: "https://example.com/verified",
            failureRedirectionURL: "https://example.com/verify-failed",
          });
        }),
      );

      expect(template.templateName).toBeDefined();

      // out-of-band verification via distilled
      const observed = yield* sesv2.getCustomVerificationEmailTemplate({
        TemplateName: template.templateName,
      });
      expect(observed.TemplateSubject).toBe("Please confirm your email");
      expect(observed.SuccessRedirectionURL).toBe(
        "https://example.com/verified",
      );

      // update subject and content in place
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Verify", {
            fromEmailAddress: FROM,
            templateSubject: "Confirm your email address",
            templateContent: "<html><body>Verify to get started.</body></html>",
            successRedirectionURL: "https://example.com/done",
            failureRedirectionURL: "https://example.com/verify-failed",
          });
        }),
      );
      const updated = yield* sesv2.getCustomVerificationEmailTemplate({
        TemplateName: template.templateName,
      });
      expect(updated.TemplateSubject).toBe("Confirm your email address");
      expect(updated.SuccessRedirectionURL).toBe("https://example.com/done");

      yield* stack.destroy();
      yield* assertCvetDeleted(template.templateName);
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!VERIFIED_FROM)(
  "custom name replaces on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Named", {
            templateName: "alchemy-test-cvet-a",
            fromEmailAddress: FROM,
            templateSubject: "A",
            templateContent: "<html><body>A</body></html>",
            successRedirectionURL: "https://example.com/a",
            failureRedirectionURL: "https://example.com/a-fail",
          });
        }),
      );
      expect(first.templateName).toBe("alchemy-test-cvet-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Named", {
            templateName: "alchemy-test-cvet-b",
            fromEmailAddress: FROM,
            templateSubject: "B",
            templateContent: "<html><body>B</body></html>",
            successRedirectionURL: "https://example.com/b",
            failureRedirectionURL: "https://example.com/b-fail",
          });
        }),
      );
      expect(second.templateName).toBe("alchemy-test-cvet-b");
      yield* assertCvetDeleted("alchemy-test-cvet-a");

      yield* stack.destroy();
      yield* assertCvetDeleted("alchemy-test-cvet-b");
    }),
  { timeout: 120_000 },
);
