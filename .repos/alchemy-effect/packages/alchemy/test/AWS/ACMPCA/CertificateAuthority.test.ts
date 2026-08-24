import * as AWS from "@/AWS";
import {
  CertificateAuthority,
  CertificateAuthorityPolicy,
  Permission,
} from "@/AWS/ACMPCA";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";
import * as acmpca from "@distilled.cloud/aws/acm-pca";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled union carries the tags the
// provider's read/reconcile/delete paths depend on. Run in every CI pass at
// near-zero cost, unlike the gated lifecycle below.
test.provider(
  "describeCertificateAuthority on a nonexistent CA fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        acmpca.describeCertificateAuthority({
          CertificateAuthorityArn: `arn:aws:acm-pca:${region}:${accountId}:certificate-authority/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getPolicy on a nonexistent CA fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // Proves the typed tag the CertificateAuthorityPolicy provider's
      // observe path treats as "no policy".
      const error = yield* Effect.flip(
        acmpca.getPolicy({
          ResourceArn: `arn:aws:acm-pca:${region}:${accountId}:certificate-authority/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "describeCertificateAuthority on a non-CA ARN fails with InvalidArnException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // A well-formed ARN whose resource type is not certificate-authority.
      // (A fully malformed string is rejected earlier as ValidationException.)
      const error = yield* Effect.flip(
        acmpca.describeCertificateAuthority({
          CertificateAuthorityArn: `arn:aws:acm-pca:${region}:${accountId}:something/else`,
        }),
      );
      expect(error._tag).toBe("InvalidArnException");
    }),
);

// Deletion leaves the CA in the DELETED state for its 7-day restoration
// window; both DELETED and fully-gone count as deleted.
const assertCaDeleted = (arn: string) =>
  acmpca.describeCertificateAuthority({ CertificateAuthorityArn: arn }).pipe(
    Effect.map((r) => r.CertificateAuthority?.Status ?? "gone"),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.flatMap((status) =>
      status === "gone" || status === "DELETED"
        ? Effect.void
        : Effect.fail(
            new Error(`CA '${arn}' still exists (status: ${status})`),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

// A private CA bills a monthly fee (prorated) for as long as it exists, so
// the live lifecycle is gated behind AWS_TEST_ACMPCA=1. It uses short-lived
// certificate mode (the cheaper tier), never activates the CA (a
// PENDING_CERTIFICATE CA deletes without disabling), and always destroys
// what it created.
test.provider.skipIf(!process.env.AWS_TEST_ACMPCA)(
  "create private CA + ACM permission, update, replace, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* AWSEnvironment.current;

      const deployCa = (props: {
        commonName: string;
        tags: Record<string, string>;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const ca = yield* CertificateAuthority("TestCA", {
              subject: { commonName: props.commonName },
              usageMode: "SHORT_LIVED_CERTIFICATE",
              permanentDeletionTime: "7 days",
              tags: props.tags,
            });
            const permission = yield* Permission("AcmRenewal", {
              certificateAuthorityArn: ca.certificateAuthorityArn,
            });
            const policy = yield* CertificateAuthorityPolicy("SharePolicy", {
              certificateAuthorityArn: ca.certificateAuthorityArn,
              policy: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                    Action: [
                      "acm-pca:DescribeCertificateAuthority",
                      "acm-pca:GetCertificate",
                      "acm-pca:GetCertificateAuthorityCertificate",
                      "acm-pca:ListPermissions",
                      "acm-pca:IssueCertificate",
                      "acm-pca:RevokeCertificate",
                    ],
                    Resource: ca.certificateAuthorityArn,
                  },
                ],
              },
            });
            return { ca, permission, policy };
          }),
        );

      // 1. CREATE — a fresh CA lands in PENDING_CERTIFICATE.
      const first = yield* deployCa({
        commonName: "alchemy-test.internal",
        tags: { fixture: "acmpca" },
      });
      expect(first.ca.certificateAuthorityArn).toContain(
        ":certificate-authority/",
      );
      expect(first.ca.status).toBe("PENDING_CERTIFICATE");
      expect(first.permission.principal).toBe("acm.amazonaws.com");

      // Out-of-band verification via distilled.
      const described = yield* acmpca.describeCertificateAuthority({
        CertificateAuthorityArn: first.ca.certificateAuthorityArn,
      });
      expect(described.CertificateAuthority?.Status).toBe(
        "PENDING_CERTIFICATE",
      );
      expect(
        described.CertificateAuthority?.CertificateAuthorityConfiguration
          ?.Subject?.CommonName,
      ).toBe("alchemy-test.internal");
      expect(described.CertificateAuthority?.UsageMode).toBe(
        "SHORT_LIVED_CERTIFICATE",
      );

      const perms = yield* acmpca.listPermissions({
        CertificateAuthorityArn: first.ca.certificateAuthorityArn,
      });
      const acmPerm = perms.Permissions?.find(
        (p) => p.Principal === "acm.amazonaws.com",
      );
      expect(acmPerm).toBeDefined();
      expect([...(acmPerm?.Actions ?? [])].sort()).toEqual([
        "GetCertificate",
        "IssueCertificate",
        "ListPermissions",
      ]);

      // The resource-based policy is attached (out-of-band via distilled).
      expect(first.policy.certificateAuthorityArn).toBe(
        first.ca.certificateAuthorityArn,
      );
      const attachedPolicy = yield* acmpca.getPolicy({
        ResourceArn: first.ca.certificateAuthorityArn,
      });
      expect(attachedPolicy.Policy).toContain(
        "acm-pca:DescribeCertificateAuthority",
      );

      // 2. UPDATE — same CA (stable ARN); tags converge in place. (The
      // permission's action set cannot shrink: AWS requires all three
      // actions for the ACM principal — a subset fails with
      // `ValidationException: Permissions must contain all three actions`.)
      const second = yield* deployCa({
        commonName: "alchemy-test.internal",
        tags: { fixture: "acmpca", updated: "true" },
      });
      expect(second.ca.certificateAuthorityArn).toBe(
        first.ca.certificateAuthorityArn,
      );
      const tags = yield* acmpca.listTags({
        CertificateAuthorityArn: second.ca.certificateAuthorityArn,
      });
      expect(tags.Tags?.find((t) => t.Key === "updated")?.Value).toBe("true");

      // 3. REPLACE — changing the subject replaces the CA; the permission
      // follows the new ARN and the old CA is deleted.
      const third = yield* deployCa({
        commonName: "alchemy-test-replaced.internal",
        tags: { fixture: "acmpca" },
      });
      expect(third.ca.certificateAuthorityArn).not.toBe(
        first.ca.certificateAuthorityArn,
      );
      expect(third.permission.certificateAuthorityArn).toBe(
        third.ca.certificateAuthorityArn,
      );
      yield* assertCaDeleted(first.ca.certificateAuthorityArn);

      // 4. DESTROY — CA enters its restoration window (DELETED).
      yield* stack.destroy();
      yield* assertCaDeleted(third.ca.certificateAuthorityArn);
    }),
  { timeout: 300_000 },
);
