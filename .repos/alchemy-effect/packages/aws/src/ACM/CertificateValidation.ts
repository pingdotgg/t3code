import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { describeCertificateDetail, waitForCertificateIssued } from "./Certificate.ts";

export interface CertificateValidationProps {
  /**
   * ARN of the ACM certificate to wait for. Changing it replaces the
   * validation.
   */
  certificateArn: string;
}

export interface CertificateValidation extends Resource<
  "AWS.ACM.CertificateValidation",
  CertificateValidationProps,
  {
    /** ARN of the issued certificate. */
    certificateArn: string;
    /** Certificate status — `ISSUED` once reconciled. */
    status: string | undefined;
    /** When the certificate was issued. */
    issuedAt: Date | undefined;
    /** When the certificate expires. */
    notAfter: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * Waits for a DNS-validated ACM certificate to be issued.
 *
 * Pair it with an `AWS.ACM.Certificate` requested with
 * `dnsValidation: "external"` whose validation records are published
 * elsewhere — typically through a DNS adapter (see
 * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Resources that
 * need an issued certificate (a CloudFront distribution, an HTTPS
 * listener, an API Gateway domain) take this resource's `certificateArn`,
 * so they deploy only after issuance. Deleting it deletes nothing.
 *
 * A `CAA_ERROR` fails with `CertificateCaaError`, naming the CAA records to
 * add. Issuance is polled for up to ten minutes.
 * ### Waiting For Issuance
 * **Example:** Certificate Validated Through Cloudflare DNS
 * ```typescript
 * const cert = yield* AWS.ACM.Certificate("Cert", {
 *   domainName: "app.example.com",
 *   dnsValidation: "external",
 * });
 * yield* Cloudflare.DNS.RecordList("CertValidation", {
 *   records: cert.domainValidationOptions.pipe(
 *     Output.map(AWS.ACM.validationRecordsOf),
 *   ),
 * });
 * const issued = yield* AWS.ACM.CertificateValidation("CertIssued", {
 *   certificateArn: cert.certificateArn,
 * });
 * // issued.certificateArn is safe to attach to a distribution or listener.
 * ```
 *
 * @resource
 */
export const CertificateValidation = Resource<CertificateValidation>(
  "AWS.ACM.CertificateValidation",
);

export const CertificateValidationProvider = () =>
  Provider.succeed(CertificateValidation, {
    stables: ["certificateArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds.certificateArn !== news.certificateArn) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const detail = yield* describeCertificateDetail(output.certificateArn);
      if (detail === undefined) return undefined;
      return {
        certificateArn: output.certificateArn,
        status: detail.Status,
        issuedAt: detail.IssuedAt,
        notAfter: detail.NotAfter,
      };
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      const detail = yield* waitForCertificateIssued(news.certificateArn);
      yield* session.note(`${news.certificateArn} ${detail.Status}`);
      return {
        certificateArn: news.certificateArn,
        status: detail.Status,
        issuedAt: detail.IssuedAt,
        notAfter: detail.NotAfter,
      };
    }),
    // Existence-only: the certificate belongs to `AWS.ACM.Certificate`.
    delete: () => Effect.void,
  });
