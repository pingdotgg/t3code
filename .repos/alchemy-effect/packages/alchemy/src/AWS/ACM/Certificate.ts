import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

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
   *
   * Updated in place via `UpdateCertificateOptions`. Note that AWS no longer
   * allows opting new public certificates out of CT logging.
   */
  certificateTransparencyLoggingPreference?: "ENABLED" | "DISABLED" | undefined;
  /**
   * Whether the certificate's private key can be exported with
   * `acm:ExportCertificate` (see the `ExportCertificate` binding).
   * Exportable public certificates carry an additional charge.
   *
   * Exportability can only be chosen when the certificate is requested —
   * ACM rejects `UpdateCertificateOptions` for it ("Export option for
   * certificates cannot be updated") — so changing this on an existing
   * certificate forces a replacement.
   */
  export?: "ENABLED" | "DISABLED" | undefined;
  /**
   * AWS region to request the certificate in.
   *
   * Defaults to `us-east-1` (the region CloudFront viewer certificates must
   * live in). Set this to the region of a regional consumer — e.g. an ALB
   * HTTPS listener requires the certificate in the load balancer's own
   * region. Changing the region replaces the certificate.
   * @default "us-east-1"
   */
  region?: string;
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
     * Certificate transparency logging preference currently on the certificate.
     */
    certificateTransparencyLoggingPreference:
      | acm.CertificateTransparencyLoggingPreference
      | undefined;
    /**
     * Whether the certificate's private key is exportable.
     */
    export: acm.CertificateExport | undefined;
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
 * @resource
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
 *
 * @example Exportable Certificate
 * ```typescript
 * // `export: "ENABLED"` lets the ExportCertificate binding retrieve the
 * // certificate together with its (encrypted) private key at runtime.
 * const cert = yield* Certificate("ExportableCertificate", {
 *   domainName: "www.example.com",
 *   hostedZoneId: "Z1234567890",
 *   export: "ENABLED",
 * });
 * ```
 *
 * @section Certificate Expiry Events
 * @example React to Approaching Expiration
 * ```typescript
 * // ACM emits "ACM Certificate Approaching Expiration" events through
 * // EventBridge — consume them with the ACM expiry event source, scoped
 * // to this certificate.
 * yield* AWS.ACM.consumeExpiryEvents(
 *   { certificateArns: [cert.certificateArn] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(
 *         `${event.detail.CommonName} expires in ${event.detail.DaysToExpiry} days`,
 *       ),
 *     ),
 * );
 * ```
 */
export const Certificate = Resource<Certificate>("AWS.ACM.Certificate");

export const CertificateProvider = () =>
  Provider.effect(
    Certificate,
    Effect.gen(function* () {
      const describeCertificate = Effect.fn(function* (certificateArn: string) {
        return yield* acm
          .describeCertificate({ CertificateArn: certificateArn })
          .pipe(
            Effect.map((response) => response.Certificate),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
            withCertRegion(regionOfCertificateArn(certificateArn)),
          );
      });

      const listCertificateTags = Effect.fn(function* (certificateArn: string) {
        return yield* acm
          .listTagsForCertificate({ CertificateArn: certificateArn })
          .pipe(
            Effect.map((response) => toTagRecord(response.Tags)),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({}),
            ),
            withCertRegion(regionOfCertificateArn(certificateArn)),
          );
      });

      const findManagedCertificate = Effect.fn(function* (
        id: string,
        props: CertificateProps,
      ) {
        // Describe candidates lazily as pages stream in and stop at the first
        // match, so pagination terminates early instead of draining every page.
        return yield* withCertRegion(props.region)(
          acm.listCertificates
            .items({
              Includes: {
                keyTypes: props.keyAlgorithm ? [props.keyAlgorithm] : undefined,
              },
            } as any)
            .pipe(
              Stream.filter(
                (summary) => summary.DomainName === props.domainName,
              ),
              Stream.mapEffect((summary) =>
                Effect.gen(function* () {
                  if (!summary.CertificateArn) {
                    return undefined;
                  }
                  const detail = yield* describeCertificate(
                    summary.CertificateArn,
                  );
                  if (!detail?.CertificateArn) {
                    return undefined;
                  }
                  if (
                    detail.DomainName !== props.domainName ||
                    JSON.stringify(
                      normalizeSanList(detail.SubjectAlternativeNames),
                    ) !==
                      JSON.stringify(
                        normalizeSanList(props.subjectAlternativeNames),
                      )
                  ) {
                    return undefined;
                  }
                  // Exportability is fixed at request time, so a certificate
                  // with a different export option can never converge to these
                  // props — it is the doomed half of a replacement, not a
                  // match.
                  if (
                    (props.export ?? "DISABLED") !==
                    (detail.Options?.Export ?? "DISABLED")
                  ) {
                    return undefined;
                  }
                  const tags = yield* listCertificateTags(
                    detail.CertificateArn,
                  );
                  return (yield* hasAlchemyTags(id, tags)) ? detail : undefined;
                }),
              ),
              Stream.filter((detail) => detail !== undefined),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
            ),
        );
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
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(60),
            ]),
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
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(60),
            ]),
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

        yield* waitForRoute53Change(response.ChangeInfo.Id);
      });

      return {
        stables: ["certificateArn"],
        list: () =>
          Effect.gen(function* () {
            // ACM certificates default to us-east-1 (CloudFront), but a
            // `region` prop can place them in the ambient region (e.g. for
            // ALB listeners) — enumerate both and dedupe by ARN, then
            // hydrate each to the full Attributes shape via describe + tags.
            const listPage = acm.listCertificates.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.CertificateSummaryList ?? [],
                ),
              ),
            );
            const summaries = [
              ...new Map(
                [...(yield* withAcmRegion(listPage)), ...(yield* listPage)].map(
                  (summary) => [summary.CertificateArn, summary] as const,
                ),
              ).values(),
            ];
            const rows = yield* Effect.forEach(
              summaries,
              (summary) =>
                Effect.gen(function* () {
                  if (!summary.CertificateArn) {
                    return undefined;
                  }
                  const detail = yield* describeCertificate(
                    summary.CertificateArn,
                  );
                  if (!detail?.CertificateArn) {
                    return undefined;
                  }
                  const tags = yield* listCertificateTags(
                    detail.CertificateArn,
                  );
                  return toAttrs(
                    {
                      domainName: detail.DomainName ?? "",
                      validationMethod:
                        detail.DomainValidationOptions?.[0]?.ValidationMethod,
                    },
                    detail,
                    tags,
                  );
                }),
              { concurrency: 10 },
            );
            return rows.filter(
              (row): row is ReturnType<typeof toAttrs> => row !== undefined,
            );
          }),
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
            // Certificates cannot move regions — a region change replaces.
            (olds.region ?? ACM_REGION) !== (news.region ?? ACM_REGION) ||
            // Exportability is fixed at request time — ACM rejects
            // `UpdateCertificateOptions` for it ("Export option for
            // certificates cannot be updated").
            (olds.export ?? "DISABLED") !== (news.export ?? "DISABLED")
          ) {
            return { action: "replace" } as const;
          }
          // `certificateTransparencyLoggingPreference` is intentionally NOT
          // a replacement trigger — it is updated in place via
          // `UpdateCertificateOptions` in `reconcile`.
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // `olds.domainName` may be `undefined` when a `creating` row was
          // persisted before upstream Outputs resolved — without a domain
          // there is nothing to search for, so report "not found" and let
          // the engine re-drive the create (reconcile finds any managed
          // certificate by tags before requesting a new one).
          const certificate = output?.certificateArn
            ? yield* describeCertificate(output.certificateArn)
            : olds?.domainName !== undefined
              ? yield* findManagedCertificate(id, olds)
              : undefined;

          if (!certificate?.CertificateArn) {
            return undefined;
          }

          const tags = yield* listCertificateTags(certificate.CertificateArn);
          return toAttrs(
            olds ?? { domainName: certificate.DomainName! },
            certificate,
            tags,
          );
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
            certificate = yield* withCertRegion(news.region)(
              acm
                .requestCertificate({
                  DomainName: news.domainName,
                  SubjectAlternativeNames: news.subjectAlternativeNames,
                  ValidationMethod:
                    news.validationMethod ?? defaultValidationMethod,
                  KeyAlgorithm: news.keyAlgorithm,
                  Options:
                    news.certificateTransparencyLoggingPreference || news.export
                      ? {
                          CertificateTransparencyLoggingPreference:
                            news.certificateTransparencyLoggingPreference,
                          Export: news.export,
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

          // Sync options — only the CT logging preference is mutable in
          // place via UpdateCertificateOptions (ACM rejects updating the
          // export option; diff treats an `export` change as replacement).
          // Diff OBSERVED options (adoption may hand us a certificate with
          // foreign options); only call the API when an explicitly-desired
          // value differs, and omit `Export` so the fixed option is left
          // untouched.
          const observedOptions = certificate.Options ?? {};
          const wantsCtChange =
            news.certificateTransparencyLoggingPreference !== undefined &&
            news.certificateTransparencyLoggingPreference !==
              observedOptions.CertificateTransparencyLoggingPreference;
          if (wantsCtChange) {
            yield* withCertRegion(regionOfCertificateArn(certificateArn))(
              acm.updateCertificateOptions({
                CertificateArn: certificateArn,
                Options: {
                  CertificateTransparencyLoggingPreference:
                    news.certificateTransparencyLoggingPreference,
                },
              }),
            );
            certificate = (yield* describeCertificate(certificateArn))!;
          }

          // Sync tags — diff observed cloud tags against desired so
          // adoption rewrites ownership tags correctly.
          const observedTags = yield* listCertificateTags(certificateArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (upsert.length > 0) {
            yield* withCertRegion(regionOfCertificateArn(certificateArn))(
              acm.addTagsToCertificate({
                CertificateArn: certificateArn,
                Tags: upsert,
              }),
            );
          }
          if (removed.length > 0) {
            yield* withCertRegion(regionOfCertificateArn(certificateArn))(
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
          yield* withCertRegion(regionOfCertificateArn(output.certificateArn))(
            acm
              .deleteCertificate({
                CertificateArn: output.certificateArn,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "ConflictException",
                  schedule: Schedule.max([
                    Schedule.fixed("2 seconds"),
                    Schedule.recurs(15),
                  ]),
                }),
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

/** @internal */
export const waitForRoute53Change = Effect.fn(function* (changeId: string) {
  return yield* route53
    .getChange({
      Id: changeId.replace(/^\/change\//, ""),
    })
    .pipe(
      Effect.map((response) => response.ChangeInfo),
      Effect.flatMap((changeInfo) =>
        changeInfo.Status === "INSYNC"
          ? Effect.succeed(changeInfo)
          : Effect.fail(new Error("Route53ChangePending")),
      ),
      Effect.retry({
        while: (error) =>
          error instanceof Error && error.message === "Route53ChangePending",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(60),
        ]),
      }),
    );
});

const ACM_REGION = "us-east-1" as const;
const defaultValidationMethod = "DNS" as const;

/**
 * Region an existing certificate lives in, parsed from its ARN
 * (`arn:aws:acm:{region}:{account}:certificate/...`).
 */
const regionOfCertificateArn = (certificateArn: string) =>
  certificateArn.split(":")[3] || ACM_REGION;

const withAcmRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // `AwsRegion`'s service value is an `Effect<RegionName>` (see
  // `@distilled.cloud/aws/Region`), so it must be provided as an effect, not a
  // bare string — providing a raw string yields a primitive into the run loop.
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed(ACM_REGION)));

/**
 * Pin ACM calls to the certificate's region: the props-requested region for
 * new certificates (default `us-east-1`), or the region parsed from an
 * existing certificate's ARN.
 */
const withCertRegion =
  (region: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        AwsRegion,
        Effect.succeed((region ?? ACM_REGION) as typeof ACM_REGION),
      ),
    );

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
  certificateTransparencyLoggingPreference:
    detail.Options?.CertificateTransparencyLoggingPreference,
  export: detail.Options?.Export,
  tags,
  issuedAt: detail.IssuedAt,
  notAfter: detail.NotAfter,
});

const isTerminalFailure = (status: acm.CertificateStatus | undefined) =>
  status === "FAILED" || status === "VALIDATION_TIMED_OUT";
