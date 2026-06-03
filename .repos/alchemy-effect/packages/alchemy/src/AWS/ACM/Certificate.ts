import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";

export interface CertificateProps {
  /**
   * Primary domain name for the certificate.
   */
  domainName: string;
  /**
   * Additional domain names to include on the certificate.
   */
  subjectAlternativeNames?: string[];
  /**
   * Validation method for the certificate request.
   * @default "DNS"
   */
  validationMethod?: acm.ValidationMethod;
  /**
   * Route 53 hosted zone used to auto-create DNS validation records.
   *
   * When provided together with `validationMethod: "DNS"`, the certificate
   * provider will upsert the validation records and wait for issuance.
   */
  hostedZoneId?: string;
  /**
   * Requested key algorithm.
   */
  keyAlgorithm?: acm.KeyAlgorithm;
  /**
   * Certificate transparency logging preference.
   */
  certificateTransparencyLoggingPreference?: "ENABLED" | "DISABLED" | undefined;
  /**
   * User-defined tags to apply to the certificate.
   */
  tags?: Record<string, string>;
}

export interface Certificate extends Resource<
  "AWS.ACM.Certificate",
  CertificateProps,
  {
    /**
     * ARN of the certificate.
     */
    certificateArn: string;
    /**
     * Primary domain name of the certificate.
     */
    domainName: string;
    /**
     * Additional subject alternative names on the certificate.
     */
    subjectAlternativeNames: string[];
    /**
     * Current ACM certificate status.
     */
    status: acm.CertificateStatus | undefined;
    /**
     * ACM-managed domain validation details, including DNS validation records.
     */
    domainValidationOptions: acm.DomainValidation[];
    /**
     * Requested validation method.
     */
    validationMethod: acm.ValidationMethod | undefined;
    /**
     * Requested key algorithm.
     */
    keyAlgorithm: acm.KeyAlgorithm | undefined;
    /**
     * Route 53 hosted zone used for automatic DNS validation, when configured.
     */
    hostedZoneId: string | undefined;
    /**
     * Current tags on the certificate.
     */
    tags: Record<string, string>;
    /**
     * Certificate issue timestamp, when issued.
     */
    issuedAt: Date | undefined;
    /**
     * Certificate expiration timestamp, when issued.
     */
    notAfter: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * An ACM certificate for CloudFront and other AWS endpoints.
 *
 * `Certificate` requests an ACM certificate in `us-east-1`, which is the
 * region required for CloudFront viewer certificates. When `hostedZoneId` is
 * provided for DNS validation, the provider creates or updates the Route 53
 * validation records and waits for the certificate to be issued.
 *
 * @section Requesting Certificates
 * @example DNS-Validated Certificate
 * ```typescript
 * const cert = yield* Certificate("WebsiteCertificate", {
 *   domainName: "www.example.com",
 *   hostedZoneId: "Z1234567890",
 * });
 * ```
 *
 * @example Certificate With SANs
 * ```typescript
 * const cert = yield* Certificate("WebsiteCertificate", {
 *   domainName: "example.com",
 *   subjectAlternativeNames: ["www.example.com"],
 *   hostedZoneId: "Z1234567890",
 * });
 * ```
 */
export const Certificate = Resource<Certificate>("AWS.ACM.Certificate");

export const CertificateProvider = () =>
  Provider.effect(
    Certificate,
    Effect.gen(function* () {
      const describeCertificate = Effect.fn(function* (certificateArn: string) {
        return yield* withAcmRegion(
          acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
            Effect.map((response) => response.Certificate),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          ),
        );
      });

      const listCertificateTags = Effect.fn(function* (certificateArn: string) {
        return yield* withAcmRegion(
          acm.listTagsForCertificate({ CertificateArn: certificateArn }).pipe(
            Effect.map((response) => toTagRecord(response.Tags)),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({}),
            ),
          ),
        );
      });

      const findManagedCertificate = Effect.fn(function* (
        id: string,
        props: CertificateProps,
      ) {
        const listed = yield* withAcmRegion(
          acm.listCertificates({
            Includes: {
              keyTypes: props.keyAlgorithm ? [props.keyAlgorithm] : undefined,
            },
          } as any),
        );

        const summaries =
          listed.CertificateSummaryList?.filter(
            (summary) => summary.DomainName === props.domainName,
          ) ?? [];

        for (const summary of summaries) {
          if (!summary.CertificateArn) {
            continue;
          }
          const detail = yield* describeCertificate(summary.CertificateArn);
          if (!detail?.CertificateArn) {
            continue;
          }
          if (
            detail.DomainName !== props.domainName ||
            JSON.stringify(normalizeSanList(detail.SubjectAlternativeNames)) !==
              JSON.stringify(normalizeSanList(props.subjectAlternativeNames))
          ) {
            continue;
          }
          const tags = yield* listCertificateTags(detail.CertificateArn);
          if (yield* hasAlchemyTags(id, tags)) {
            return detail;
          }
        }

        return undefined;
      });

      const waitForValidationRecords = Effect.fn(function* (
        certificateArn: string,
      ) {
        return yield* describeCertificate(certificateArn).pipe(
          Effect.flatMap((detail) => {
            const validations = detail?.DomainValidationOptions ?? [];
            if (
              validations.length === 0 ||
              validations.some((option) => option.ResourceRecord === undefined)
            ) {
              return Effect.fail(
                new Error("CertificateValidationRecordPending"),
              );
            }
            return Effect.succeed(detail!);
          }),
          Effect.retry({
            while: (error) =>
              error instanceof Error &&
              error.message === "CertificateValidationRecordPending",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      const waitForIssued = Effect.fn(function* (certificateArn: string) {
        return yield* describeCertificate(certificateArn).pipe(
          Effect.flatMap((detail) => {
            if (!detail?.CertificateArn) {
              return Effect.fail(new Error("CertificateNotFound"));
            }
            if (detail.Status === "ISSUED") {
              return Effect.succeed(detail);
            }
            if (isTerminalFailure(detail.Status)) {
              return Effect.fail(
                new Error(
                  `Certificate issuance failed with status ${detail.Status}${detail.FailureReason ? ` (${detail.FailureReason})` : ""}`,
                ),
              );
            }
            return Effect.fail(new Error("CertificatePendingValidation"));
          }),
          Effect.retry({
            while: (error) =>
              error instanceof Error &&
              error.message === "CertificatePendingValidation",
            schedule: Schedule.fixed("10 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      const waitForChange = Effect.fn(function* (changeId: string) {
        return yield* route53.getChange({ Id: changeId }).pipe(
          Effect.map((response) => response.ChangeInfo),
          Effect.flatMap((changeInfo) =>
            changeInfo.Status === "INSYNC"
              ? Effect.succeed(changeInfo)
              : Effect.fail(new Error("Route53ChangePending")),
          ),
          Effect.retry({
            while: (error) =>
              error instanceof Error &&
              error.message === "Route53ChangePending",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      const upsertValidationRecords = Effect.fn(function* (
        hostedZoneId: string,
        certificate: acm.CertificateDetail,
      ) {
        const changes = (certificate.DomainValidationOptions ?? [])
          .flatMap((option) =>
            option.ResourceRecord ? [option.ResourceRecord] : [],
          )
          .map((record) => ({
            Action: "UPSERT" as const,
            ResourceRecordSet: {
              Name: record.Name,
              Type: record.Type,
              TTL: 60,
              ResourceRecords: [{ Value: record.Value }],
            },
          }));

        if (changes.length === 0) {
          return;
        }

        const response = yield* route53.changeResourceRecordSets({
          HostedZoneId: normalizeHostedZoneId(hostedZoneId),
          ChangeBatch: {
            Comment: "Alchemy ACM DNS validation",
            Changes: changes,
          },
        });

        yield* waitForChange(response.ChangeInfo.Id);
      });

      return {
        stables: ["certificateArn"],
        diff: Effect.fn(function* ({ olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          if (
            olds.domainName !== news.domainName ||
            !deepEqual(
              normalizeSanList(olds.subjectAlternativeNames),
              normalizeSanList(news.subjectAlternativeNames),
            ) ||
            (olds.validationMethod ?? defaultValidationMethod) !==
              (news.validationMethod ?? defaultValidationMethod) ||
            olds.hostedZoneId !== news.hostedZoneId ||
            olds.keyAlgorithm !== news.keyAlgorithm ||
            olds.certificateTransparencyLoggingPreference !==
              news.certificateTransparencyLoggingPreference
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const certificate = output?.certificateArn
            ? yield* describeCertificate(output.certificateArn)
            : yield* findManagedCertificate(id, olds!);

          if (!certificate?.CertificateArn) {
            return undefined;
          }

          const tags = yield* listCertificateTags(certificate.CertificateArn);
          return toAttrs(olds!, certificate, tags);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          output,
          session,
        }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — find the live certificate. Domain + SAN combo plus
          // alchemy-owned tags identify a certificate uniquely; if we have
          // a cached ARN, prefer that as the fast path. ACM certificates
          // can't be renamed, and most fields trigger replace via diff,
          // so the only real ensure path is "request if no managed
          // certificate exists".
          let certificate = output?.certificateArn
            ? yield* describeCertificate(output.certificateArn)
            : undefined;
          if (!certificate?.CertificateArn) {
            certificate = yield* findManagedCertificate(id, news);
          }

          // Ensure — request a new certificate if none exists. The
          // `IdempotencyToken` (derived from `instanceId`) makes the
          // request safe to retry.
          if (!certificate?.CertificateArn) {
            certificate = yield* withAcmRegion(
              acm
                .requestCertificate({
                  DomainName: news.domainName,
                  SubjectAlternativeNames: news.subjectAlternativeNames,
                  ValidationMethod:
                    news.validationMethod ?? defaultValidationMethod,
                  KeyAlgorithm: news.keyAlgorithm,
                  Options: news.certificateTransparencyLoggingPreference
                    ? {
                        CertificateTransparencyLoggingPreference:
                          news.certificateTransparencyLoggingPreference,
                      }
                    : undefined,
                  IdempotencyToken: instanceId
                    .replaceAll(/[^a-zA-Z0-9]/g, "")
                    .slice(0, 32),
                  Tags: createTagsList(desiredTags),
                })
                .pipe(
                  Effect.flatMap((response) =>
                    response.CertificateArn
                      ? describeCertificate(response.CertificateArn).pipe(
                          Effect.map((detail) => detail!),
                        )
                      : Effect.fail(
                          new Error(
                            "requestCertificate returned no certificate ARN",
                          ),
                        ),
                  ),
                ),
            );
          }

          if (!certificate?.CertificateArn) {
            return yield* Effect.fail(
              new Error("Failed to obtain ACM certificate"),
            );
          }

          const certificateArn = certificate.CertificateArn;
          yield* session.note(certificateArn);

          // Sync DNS validation. If the user wired a hostedZoneId, ensure
          // validation records are upserted and the cert reaches `ISSUED`.
          // For an already-issued cert this is mostly a fast-path: we only
          // wait for validation records when the cert isn't already issued.
          const shouldAutoValidate =
            (news.validationMethod ?? defaultValidationMethod) === "DNS" &&
            news.hostedZoneId !== undefined;

          if (shouldAutoValidate && certificate.Status !== "ISSUED") {
            const withRecords = yield* waitForValidationRecords(certificateArn);
            yield* upsertValidationRecords(news.hostedZoneId!, withRecords);
            certificate = yield* waitForIssued(certificateArn);
          }

          // Sync tags — diff observed cloud tags against desired so
          // adoption rewrites ownership tags correctly.
          const observedTags = yield* listCertificateTags(certificateArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (upsert.length > 0) {
            yield* withAcmRegion(
              acm.addTagsToCertificate({
                CertificateArn: certificateArn,
                Tags: upsert,
              }),
            );
          }
          if (removed.length > 0) {
            yield* withAcmRegion(
              acm.removeTagsFromCertificate({
                CertificateArn: certificateArn,
                Tags: removed.map((Key) => ({ Key })),
              }),
            );
          }

          // Re-read so the returned attributes reflect any tag mutation.
          const finalTags = yield* listCertificateTags(certificateArn);
          return toAttrs(news, certificate, finalTags);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* withAcmRegion(
            acm
              .deleteCertificate({
                CertificateArn: output.certificateArn,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

const ACM_REGION = "us-east-1" as const;
const defaultValidationMethod = "DNS" as const;

const withAcmRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, ACM_REGION as any));

const normalizeHostedZoneId = (hostedZoneId: string) =>
  hostedZoneId.replace(/^\/hostedzone\//, "");

const normalizeSanList = (names: string[] | undefined) =>
  [...(names ?? [])].sort((a, b) => a.localeCompare(b));

const toTagRecord = (tags: acm.Tag[] | undefined) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = (
  props: CertificateProps,
  detail: acm.CertificateDetail,
  tags: Record<string, string>,
) => ({
  certificateArn: detail.CertificateArn!,
  domainName: detail.DomainName ?? props.domainName,
  subjectAlternativeNames: detail.SubjectAlternativeNames ?? [],
  status: detail.Status,
  domainValidationOptions: detail.DomainValidationOptions ?? [],
  validationMethod: props.validationMethod ?? defaultValidationMethod,
  keyAlgorithm: detail.KeyAlgorithm ?? props.keyAlgorithm,
  hostedZoneId: props.hostedZoneId
    ? normalizeHostedZoneId(props.hostedZoneId)
    : undefined,
  tags,
  issuedAt: detail.IssuedAt,
  notAfter: detail.NotAfter,
});

const isTerminalFailure = (status: acm.CertificateStatus | undefined) =>
  status === "FAILED" || status === "VALIDATION_TIMED_OUT";
