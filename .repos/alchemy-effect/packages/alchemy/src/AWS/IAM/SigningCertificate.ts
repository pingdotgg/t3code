import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface SigningCertificateProps {
  /**
   * User that owns the signing certificate.
   */
  userName: string;
  /**
   * X.509 signing certificate body.
   */
  certificateBody: string;
  /**
   * Desired certificate status.
   * @default "Active"
   */
  status?: iam.StatusType;
}

export interface SigningCertificate extends Resource<
  "AWS.IAM.SigningCertificate",
  SigningCertificateProps,
  {
    userName: string;
    certificateId: string;
    certificateBody: string;
    status: iam.StatusType;
    uploadDate: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * An IAM signing certificate for a user.
 *
 * `SigningCertificate` uploads an X.509 signing certificate for legacy
 * IAM-integrated workflows that still depend on user-scoped certificates.
 *
 * @section Managing User Certificates
 * @example Upload a Signing Certificate
 * ```typescript
 * const user = yield* User("Signer", {
 *   userName: "build-signer",
 * });
 *
 * const certificate = yield* SigningCertificate("SigningCertificate", {
 *   userName: user.userName,
 *   certificateBody: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
 * });
 * ```
 */
export const SigningCertificate = Resource<SigningCertificate>(
  "AWS.IAM.SigningCertificate",
);

export const SigningCertificateProvider = () =>
  Provider.succeed(SigningCertificate, {
    stables: ["certificateId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (
        olds.userName !== news.userName ||
        olds.certificateBody !== news.certificateBody
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const listed = yield* iam.listSigningCertificates({
        UserName: output.userName,
      });
      const cert = listed.Certificates.find(
        (entry) => entry.CertificateId === output.certificateId,
      );
      if (!cert?.CertificateId) {
        return undefined;
      }
      return {
        userName: cert.UserName,
        certificateId: cert.CertificateId,
        certificateBody: cert.CertificateBody,
        status: cert.Status,
        uploadDate: cert.UploadDate,
      };
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      // Observe — certificate ids are AWS-generated; we can only locate
      // the live entry via the prior output. The certificate body is
      // immutable (`diff` triggers replacement on body change), so a
      // missing entry always means we need to upload.
      const observed = output
        ? yield* iam
            .listSigningCertificates({ UserName: output.userName })
            .pipe(
              Effect.map((r) =>
                r.Certificates.find(
                  (entry) => entry.CertificateId === output.certificateId,
                ),
              ),
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            )
        : undefined;

      // Ensure — upload when missing.
      let cert = observed;
      if (!cert?.CertificateId) {
        const uploaded = yield* iam.uploadSigningCertificate({
          UserName: news.userName,
          CertificateBody: news.certificateBody,
        });
        cert = uploaded.Certificate;
      }

      // Sync — apply the desired status when it differs.
      const desiredStatus = news.status ?? cert.Status;
      if (desiredStatus !== cert.Status) {
        yield* iam.updateSigningCertificate({
          UserName: news.userName,
          CertificateId: cert.CertificateId,
          Status: desiredStatus,
        });
      }

      yield* session.note(cert.CertificateId);
      return {
        userName: cert.UserName,
        certificateId: cert.CertificateId,
        certificateBody: cert.CertificateBody,
        status: desiredStatus,
        uploadDate: cert.UploadDate,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteSigningCertificate({
          UserName: output.userName,
          CertificateId: output.certificateId,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
