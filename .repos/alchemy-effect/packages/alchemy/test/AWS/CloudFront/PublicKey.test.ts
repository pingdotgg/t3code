import * as AWS from "@/AWS";
import { PublicKey } from "@/AWS/CloudFront";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvTkfqkMHU8HMmIRKJaMl
IoD691g60aS15QlaP/DVkpuoeEp8JA8YDs5vQFu6HSIYCTQ7WwFx9oRvN08i7yXB
EHt3x7uZVpdkp6JBbjR9BGNsAVri6DZ0TJQ11zWeN3keqhnUdFhQjPwT+u4r6oKk
kNvkl7eU2nFK+UIaPlD+rA+AlYT0m7gSVcd9KaLf/UzBrtSy1dbXYDT4dHChMUVy
4gDsQ6D4u6lRAHY9jcKxlgEIM+O8ODKyzlbergv2EwhANG4P27DBeDhA/off3upM
TTVTGKZeoABtqM0ZiYq0cDgf8KUn9NPxSdnJ4+cbigLjJBPS93VYWzWX0HXlZpQ3
HQIDAQAB
-----END PUBLIC KEY-----
`;

describe("AWS.CloudFront.PublicKey", () => {
  test.provider.skipIf(!runLive)(
    "create, update comment, and delete a public key",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* PublicKey("SignedUrlKey", {
              encodedKey: TEST_PUBLIC_KEY,
              comment: "initial",
            });
          }),
        );

        const initial = yield* cloudfront.getPublicKey({
          Id: created.publicKeyId,
        });
        expect(initial.PublicKey?.Id).toEqual(created.publicKeyId);
        expect(initial.PublicKey?.PublicKeyConfig?.Comment).toEqual("initial");
        expect(initial.PublicKey?.PublicKeyConfig?.EncodedKey).toEqual(
          TEST_PUBLIC_KEY,
        );

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* PublicKey("SignedUrlKey", {
              encodedKey: TEST_PUBLIC_KEY,
              comment: "updated",
            });
          }),
        );

        expect(updated.publicKeyId).toEqual(created.publicKeyId);
        expect(updated.callerReference).toEqual(created.callerReference);

        const after = yield* cloudfront.getPublicKey({
          Id: updated.publicKeyId,
        });
        expect(after.PublicKey?.PublicKeyConfig?.Comment).toEqual("updated");

        yield* stack.destroy();
        yield* assertPublicKeyDeleted(updated.publicKeyId);
      }),
    { timeout: 300_000 },
  );
});

const assertPublicKeyDeleted = (id: string) =>
  cloudfront.getPublicKey({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("PublicKeyStillExists"))),
    Effect.catchTag("NoSuchPublicKey", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "PublicKeyStillExists",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(24)),
      ),
    }),
  );
