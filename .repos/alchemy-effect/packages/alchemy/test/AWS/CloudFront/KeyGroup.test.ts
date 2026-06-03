import * as AWS from "@/AWS";
import { KeyGroup, PublicKey } from "@/AWS/CloudFront";
import * as Test from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const PRIMARY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvTkfqkMHU8HMmIRKJaMl
IoD691g60aS15QlaP/DVkpuoeEp8JA8YDs5vQFu6HSIYCTQ7WwFx9oRvN08i7yXB
EHt3x7uZVpdkp6JBbjR9BGNsAVri6DZ0TJQ11zWeN3keqhnUdFhQjPwT+u4r6oKk
kNvkl7eU2nFK+UIaPlD+rA+AlYT0m7gSVcd9KaLf/UzBrtSy1dbXYDT4dHChMUVy
4gDsQ6D4u6lRAHY9jcKxlgEIM+O8ODKyzlbergv2EwhANG4P27DBeDhA/off3upM
TTVTGKZeoABtqM0ZiYq0cDgf8KUn9NPxSdnJ4+cbigLjJBPS93VYWzWX0HXlZpQ3
HQIDAQAB
-----END PUBLIC KEY-----
`;

const SECONDARY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu6QT6PtJ4O4Xcy6C8BkI
NHDRF8TnPbWZlVFYXr4R9miLMlORiH34sUtyYAwYlvHyYlrL76Z4A8HaLTMDfCf5
eswQr0r7qVOstRJrEW8ycTXJw/8Mj+1KKSrs8QopVZBMEnOfiUsentnWhQgKSpbI
mA4sLTg45jBoaZi9c8M40psgAp/1vPn5zeloAjoku5ax18FM32yRi9C21J84BWCd
vp6E7NtzJh9XlH22xOPGmbCh1r3uAtiujpXj1UNw/QEMooiEsJAeoROpvHZkh6/m
VZUU1njrXaTMl4OUd+I+Y96eWWo539vU0dD5XnUUNuYybwI6FeVmrouHR9wG4RJL
JQIDAQAB
-----END PUBLIC KEY-----
`;

describe("AWS.CloudFront.KeyGroup", () => {
  test.provider.skipIf(!runLive)(
    "create, update items, and delete a key group",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const primary = yield* PublicKey("PrimarySigningKey", {
              encodedKey: PRIMARY_PUBLIC_KEY,
              comment: "primary",
            });
            const secondary = yield* PublicKey("SecondarySigningKey", {
              encodedKey: SECONDARY_PUBLIC_KEY,
              comment: "secondary",
            });
            const group = yield* KeyGroup("SignedUrlKeys", {
              comment: "initial",
              items: [primary.publicKeyId],
            });
            return { primary, secondary, group };
          }),
        );

        const initial = yield* cloudfront.getKeyGroup({
          Id: created.group.keyGroupId,
        });
        expect(initial.KeyGroup?.Id).toEqual(created.group.keyGroupId);
        expect(initial.KeyGroup?.KeyGroupConfig?.Comment).toEqual("initial");
        expect(initial.KeyGroup?.KeyGroupConfig?.Items).toEqual([
          created.primary.publicKeyId,
        ]);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const primary = yield* PublicKey("PrimarySigningKey", {
              encodedKey: PRIMARY_PUBLIC_KEY,
              comment: "primary",
            });
            const secondary = yield* PublicKey("SecondarySigningKey", {
              encodedKey: SECONDARY_PUBLIC_KEY,
              comment: "secondary",
            });
            const group = yield* KeyGroup("SignedUrlKeys", {
              comment: "updated",
              items: [primary.publicKeyId, secondary.publicKeyId],
            });
            return { primary, secondary, group };
          }),
        );

        expect(updated.group.keyGroupId).toEqual(created.group.keyGroupId);

        const after = yield* cloudfront.getKeyGroup({
          Id: updated.group.keyGroupId,
        });
        expect(after.KeyGroup?.KeyGroupConfig?.Comment).toEqual("updated");
        expect(after.KeyGroup?.KeyGroupConfig?.Items).toEqual([
          updated.primary.publicKeyId,
          updated.secondary.publicKeyId,
        ]);

        yield* stack.destroy();
        yield* assertKeyGroupDeleted(updated.group.keyGroupId);
      }),
    { timeout: 300_000 },
  );
});

const assertKeyGroupDeleted = (id: string) =>
  cloudfront.getKeyGroup({ Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("KeyGroupStillExists"))),
    Effect.catchTag("NoSuchResource", () => Effect.void),
    Effect.retry({
      while: (error) =>
        error instanceof Error && error.message === "KeyGroupStillExists",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(24)),
      ),
    }),
  );
