import * as acm from "@distilled.cloud/aws/acm";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as route53 from "@distilled.cloud/aws/route-53";
import { deepEqual, isResolved } from "alchemy/Diff";
import type { DnsRecord } from "alchemy/DNS/Adapter";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import { createInternalTags, createTagsList, diffTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";
import { findPublicHostedZoneId } from "../Route53/HostedZoneLookup.ts";

export class CertificateNotReady extends Data.TaggedError("CertificateNotReady")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CertificateUnexpectedResponse extends Data.TaggedError(
  "CertificateUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CertificateOperationFailed extends Data.TaggedError("CertificateOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
   * With `validationMethod: "DNS"` the certificate provider upserts the
   * validation records into this zone and waits for issuance. When
   * omitted, the most specific PUBLIC hosted zone in the account
   * containing `domainName` is inferred; if none matches, validation is
   * left to the caller (external DNS) and the certificate is returned
   * pending.
   */
  hostedZoneId?: string;
  /**
   * Who publishes the DNS validation records (with `validationMethod:
   * "DNS"`).
   *
   * - `"route53"` — the provider upserts them into Route 53
   *   ({@link hostedZoneId}, or the inferred public zone) and waits for
   *   issuance.
   * - `"external"` — the provider only waits until ACM has computed the
   *   records and returns the certificate `PENDING_VALIDATION` with
   *   `domainValidationOptions` filled in. Publish them yourself — e.g.
   *   through a DNS adapter with {@link validationRecordsOf} — and wait for
   *   issuance with `AWS.ACM.CertificateValidation`. This is what AWS
   *   composites do for a `domain.dns` outside Route 53.
   *
   * @default "route53"
   */
  dnsValidation?: "route53" | "external";
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

/**
 * Binding contract of {@link Certificate}: composites contribute additional
 * subject alternative names without a circular input prop (e.g. a site
 * attached to an `AWS.Website.Router` binds its hostnames onto the Router's
 * certificate). ACM certificates are immutable — a change in the bound SAN
 * set plans a REPLACEMENT (new certificate requested and validated first,
 * consumers re-pointed, old certificate deleted last).
 */
export type CertificateBinding = {
  /**
   * Additional subject alternative names merged into the certificate's SAN
   * set at reconcile time.
   */
  subjectAlternativeNames?: string[];
};

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
  CertificateBinding,
  Providers
> {}

/**
 * Effective SAN set: declared props plus bound SANs (see
 * {@link CertificateBinding}), deduped. Tolerates both `{ sid, data }` rows
 * (provider lifecycle) and bare binding payloads.
 * @internal
 */
const resolveEffectiveSans = (
  declared: string[] | undefined,
  bindings: ReadonlyArray<CertificateBinding | ResourceBinding<CertificateBinding>> | undefined,
): string[] | undefined => {
  const bound = (bindings ?? []).flatMap((binding) =>
    "data" in binding && binding.data !== undefined
      ? ((binding as ResourceBinding<CertificateBinding>).data.subjectAlternativeNames ?? [])
      : ((binding as CertificateBinding).subjectAlternativeNames ?? []),
  );
  if (bound.length === 0) {
    return declared;
  }
  return [...new Set([...(declared ?? []), ...bound])];
};

/**
 * ACM refused to issue the certificate because a CAA record on the domain
 * does not authorize Amazon. Alchemy never writes CAA records itself — add
 * the records named in the message at the zone apex and redeploy.
 */
export class CertificateCaaError extends Data.TaggedError("CertificateCaaError")<{
  readonly certificateArn: string;
  readonly domainName: string;
}> {
  override get message() {
    return (
      `ACM could not issue ${this.certificateArn} for ${this.domainName}: a CAA record on the domain does not authorize Amazon (CAA_ERROR). ` +
      `Add CAA records at the zone apex — \`0 issue "amazon.com"\` and \`0 issue "amazonaws.com"\` (plus the same with \`issuewild\` for wildcard names) — then redeploy.`
    );
  }
}

/**
 * An ACM certificate for CloudFront and other AWS endpoints.
 *
 * `Certificate` requests an ACM certificate in `us-east-1`, which is the
 * region required for CloudFront viewer certificates. With DNS validation,
 * the provider creates or updates the Route 53 validation records
 * (`hostedZoneId`, or the inferred public zone) and waits for the
 * certificate to be issued. With `dnsValidation: "external"` the records
 * are published elsewhere — e.g. through a DNS adapter — and
 * `AWS.ACM.CertificateValidation` waits for issuance.
 * ### Requesting Certificates
 * **Example:** DNS-Validated Certificate
 * ```typescript
 * const cert = yield* Certificate("WebsiteCertificate", {
 *   domainName: "www.example.com",
 *   hostedZoneId: "Z1234567890",
 * });
 * ```
 *
 * **Example:** Certificate With SANs
 * ```typescript
 * const cert = yield* Certificate("WebsiteCertificate", {
 *   domainName: "example.com",
 *   subjectAlternativeNames: ["www.example.com"],
 *   hostedZoneId: "Z1234567890",
 * });
 * ```
 *
 * **Example:** Exportable Certificate
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
 * **Example:** Certificate Validated Through Another DNS Host
 * ```typescript
 * // DNS lives in Cloudflare: publish ACM's validation CNAMEs through the
 * // Cloudflare DNS adapter, then wait for issuance. AWS composites do this
 * // for you when `domain.dns` is set.
 * const cert = yield* Certificate("WebsiteCertificate", {
 *   domainName: "www.example.com",
 *   dnsValidation: "external",
 * });
 * const dns = yield* DNS.resolve(Cloudflare.DNS.Adapter());
 * yield* dns.records("WebsiteCertificateValidation", {
 *   records: cert.domainValidationOptions.pipe(
 *     Output.map(validationRecordsOf),
 *   ),
 *   retain: true,
 * });
 * const issued = yield* CertificateValidation("WebsiteCertificateIssued", {
 *   certificateArn: cert.certificateArn,
 * });
 * ```
 *
 * ### Certificate Expiry Events
 * **Example:** React to Approaching Expiration
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
 *
 * @resource
 */
export const Certificate = Resource<Certificate>("AWS.ACM.Certificate");

export const CertificateProvider = () =>
  Provider.effect(
    Certificate,
    Effect.gen(function* () {
      const describeCertificate = Effect.fn(function* (certificateArn: string) {
        return yield* acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
          Effect.map((response) => response.Certificate),
          Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
          withCertRegion(regionOfCertificateArn(certificateArn)),
        );
      });

      const listCertificateTags = Effect.fn(function* (certificateArn: string) {
        return yield* acm.listTagsForCertificate({ CertificateArn: certificateArn }).pipe(
          Effect.map((response) => toTagRecord(response.Tags)),
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed({})),
          withCertRegion(regionOfCertificateArn(certificateArn)),
        );
      });

      const findManagedCertificate = Effect.fn(function* (id: string, props: CertificateProps) {
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
              Stream.filter((summary) => summary.DomainName === props.domainName),
              Stream.mapEffect((summary) =>
                Effect.gen(function* () {
                  if (!summary.CertificateArn) {
                    return undefined;
                  }
                  const detail = yield* describeCertificate(summary.CertificateArn);
                  if (!detail?.CertificateArn) {
                    return undefined;
                  }
                  if (
                    detail.DomainName !== props.domainName ||
                    JSON.stringify(normalizeSanList(detail.SubjectAlternativeNames)) !==
                      JSON.stringify(normalizeSanList(props.subjectAlternativeNames))
                  ) {
                    return undefined;
                  }
                  // Exportability is fixed at request time, so a certificate
                  // with a different export option can never converge to these
                  // props — it is the doomed half of a replacement, not a
                  // match.
                  if ((props.export ?? "DISABLED") !== (detail.Options?.Export ?? "DISABLED")) {
                    return undefined;
                  }
                  const tags = yield* listCertificateTags(detail.CertificateArn);
                  return (yield* hasAlchemyTags(id, tags)) ? detail : undefined;
                }),
              ),
              Stream.filter((detail) => detail !== undefined),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
            ),
        );
      });

      const waitForValidationRecords = Effect.fn(function* (certificateArn: string) {
        return yield* describeCertificate(certificateArn).pipe(
          Effect.flatMap((detail) => {
            const validations = detail?.DomainValidationOptions ?? [];
            if (
              validations.length === 0 ||
              validations.some((option) => option.ResourceRecord === undefined)
            ) {
              return Effect.fail(
                new CertificateNotReady({ message: "CertificateValidationRecordPending" }),
              );
            }
            return Effect.succeed(detail!);
          }),
          Effect.retry({
            while: (error) =>
              error._tag === "CertificateNotReady" &&
              error.message === "CertificateValidationRecordPending",
            schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(60)]),
          }),
        );
      });

      const waitForIssued = (certificateArn: string) => waitForCertificateIssued(certificateArn);

      const upsertValidationRecords = Effect.fn(function* (
        hostedZoneId: string,
        certificate: acm.CertificateDetail,
      ) {
        // A name and its wildcard (`example.com` + `*.example.com`) share one
        // validation record. Route 53 rejects a batch that changes the same
        // record twice, so keep one change per name and type.
        const records = new Map(
          (certificate.DomainValidationOptions ?? [])
            .flatMap((option) => (option.ResourceRecord ? [option.ResourceRecord] : []))
            .map((record) => [`${record.Name} ${record.Type}`, record] as const),
        );
        const changes = [...records.values()].map((record) => ({
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
                Array.from(chunk).flatMap((page) => page.CertificateSummaryList ?? []),
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
                  const detail = yield* describeCertificate(summary.CertificateArn);
                  if (!detail?.CertificateArn) {
                    return undefined;
                  }
                  const tags = yield* listCertificateTags(detail.CertificateArn);
                  return toAttrs(
                    {
                      domainName: detail.DomainName ?? "",
                      validationMethod: detail.DomainValidationOptions?.[0]?.ValidationMethod,
                    },
                    detail,
                    tags,
                  );
                }),
              { concurrency: 10 },
            );
            return rows.filter((row): row is ReturnType<typeof toAttrs> => row !== undefined);
          }),
        diff: Effect.fn(function* ({ olds, news: _news, oldBindings, newBindings: _newBindings }) {
          if (!isResolved(_news) || !isResolved(_newBindings)) {
            return undefined;
          }
          const news = _news as typeof olds;
          const newBindings = _newBindings as ResourceBinding<CertificateBinding>[];
          if (
            olds.domainName !== news.domainName ||
            // ACM certificates are immutable: the SAN set — declared props
            // plus SANs contributed through the binding contract — cannot
            // change in place, so any delta plans a replacement.
            !deepEqual(
              normalizeSanList(resolveEffectiveSans(olds.subjectAlternativeNames, oldBindings)),
              normalizeSanList(resolveEffectiveSans(news.subjectAlternativeNames, newBindings)),
            ) ||
            (olds.validationMethod ?? defaultValidationMethod) !==
              (news.validationMethod ?? defaultValidationMethod) ||
            // An undefined side means "inferred" — only two explicit,
            // differing zones are a replacement.
            (olds.hostedZoneId !== undefined &&
              news.hostedZoneId !== undefined &&
              olds.hostedZoneId !== news.hostedZoneId) ||
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
          return toAttrs(olds ?? { domainName: certificate.DomainName! }, certificate, tags);
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news: _news,
          output,
          session,
          bindings,
        }) {
          // Fold bound SANs (see `CertificateBinding`) into the desired
          // props up front so every downstream step — managed-certificate
          // lookup, request, attrs — sees the effective SAN set.
          const news: typeof _news = {
            ..._news,
            subjectAlternativeNames: resolveEffectiveSans(_news.subjectAlternativeNames, bindings),
          };
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
                  // ACM rejects an empty list (min length 1) — composites
                  // pass `[]` for a domain without aliases.
                  SubjectAlternativeNames:
                    news.subjectAlternativeNames && news.subjectAlternativeNames.length > 0
                      ? news.subjectAlternativeNames
                      : undefined,
                  ValidationMethod: news.validationMethod ?? defaultValidationMethod,
                  KeyAlgorithm: news.keyAlgorithm,
                  Options:
                    news.certificateTransparencyLoggingPreference || news.export
                      ? {
                          CertificateTransparencyLoggingPreference:
                            news.certificateTransparencyLoggingPreference,
                          Export: news.export,
                        }
                      : undefined,
                  IdempotencyToken: instanceId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 32),
                  Tags: createTagsList(desiredTags),
                })
                .pipe(
                  Effect.flatMap(
                    Effect.fnUntraced(function* (response) {
                      if (!response.CertificateArn) {
                        return yield* new CertificateUnexpectedResponse({
                          message: "requestCertificate returned no certificate ARN",
                        });
                      }
                      return (yield* describeCertificate(response.CertificateArn))!;
                    }),
                  ),
                ),
            );
          }

          if (!certificate?.CertificateArn) {
            return yield* new CertificateOperationFailed({
              message: "Failed to obtain ACM certificate",
            });
          }

          const certificateArn = certificate.CertificateArn;
          yield* session.note(certificateArn);

          // Sync DNS validation: ensure validation records are upserted and
          // the cert reaches `ISSUED`. With `dnsValidation: "external"` the
          // caller publishes them (a DNS adapter). Otherwise the zone is
          // the explicit `hostedZoneId` when given, or the most specific
          // public zone containing `domainName`; when neither yields a zone,
          // validation is left to the caller (external DNS) and the
          // certificate is returned pending — the pre-inference behavior.
          // For an already-issued cert this is a fast-path: we only wait
          // for validation records when the cert isn't already issued.
          if (
            (news.validationMethod ?? defaultValidationMethod) === "DNS" &&
            certificate.Status !== "ISSUED"
          ) {
            if (news.dnsValidation === "external") {
              // The caller publishes the records: surface them on the
              // attributes and return pending.
              certificate = yield* waitForValidationRecords(certificateArn);
            } else {
              const validationZoneId =
                news.hostedZoneId ?? (yield* findPublicHostedZoneId(news.domainName));
              if (validationZoneId !== undefined) {
                const withRecords = yield* waitForValidationRecords(certificateArn);
                yield* upsertValidationRecords(validationZoneId, withRecords);
                certificate = yield* waitForIssued(certificateArn);
              }
            }
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
                // `ResourceInUseException` covers the certificate-swap path:
                // when a SAN change replaces the certificate, CloudFront can
                // keep reporting the detached old certificate as in-use for a
                // few minutes after the distribution update deploys — ride
                // that out with a bounded wait instead of failing the delete.
                Effect.retry({
                  while: (e): boolean =>
                    e._tag === "ConflictException" || e._tag === "ResourceInUseException",
                  schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(30)]),
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
          : Effect.fail(new CertificateNotReady({ message: "Route53ChangePending" })),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "CertificateNotReady" && error.message === "Route53ChangePending",
        schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(60)]),
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
      Effect.provideService(AwsRegion, Effect.succeed((region ?? ACM_REGION) as typeof ACM_REGION)),
    );

const normalizeHostedZoneId = (hostedZoneId: string) => hostedZoneId.replace(/^\/hostedzone\//, "");

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
  hostedZoneId: props.hostedZoneId ? normalizeHostedZoneId(props.hostedZoneId) : undefined,
  certificateTransparencyLoggingPreference:
    detail.Options?.CertificateTransparencyLoggingPreference,
  export: detail.Options?.Export,
  tags,
  issuedAt: detail.IssuedAt,
  notAfter: detail.NotAfter,
});

/**
 * The DNS validation records of a certificate's `domainValidationOptions`,
 * shaped for a DNS adapter's `records(...)` (or any `RecordList`). A
 * wildcard and its apex (`*.example.com` + `example.com`) share one CNAME,
 * so records are deduped by type + name.
 *
 * **Example:**
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
 * ```
 */
export const validationRecordsOf = (
  domainValidationOptions: acm.DomainValidation[] | undefined,
): DnsRecord[] => [
  ...new Map(
    (domainValidationOptions ?? []).flatMap((option) =>
      option.ResourceRecord
        ? [
            [
              `${option.ResourceRecord.Type}:${option.ResourceRecord.Name.toLowerCase()}`,
              {
                name: option.ResourceRecord.Name,
                type: option.ResourceRecord.Type as DnsRecord["type"],
                value: option.ResourceRecord.Value,
              },
            ] as const,
          ]
        : [],
    ),
  ).values(),
];

/**
 * Describe a certificate in its own region; `undefined` when it is gone.
 * @internal shared with `CertificateValidation`
 */
export const describeCertificateDetail = (certificateArn: string) =>
  acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
    Effect.map((response) => response.Certificate),
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
    withCertRegion(regionOfCertificateArn(certificateArn)),
  );

/**
 * Poll a certificate until ACM issues it (bounded: 10s × 60). Fails with
 * {@link CertificateCaaError} on `CAA_ERROR`, and with an error naming the
 * status on any other terminal failure.
 * @internal shared with `CertificateValidation`
 */
export const waitForCertificateIssued = (certificateArn: string) =>
  describeCertificateDetail(certificateArn).pipe(
    Effect.flatMap(
      Effect.fnUntraced(function* (detail) {
        if (!detail?.CertificateArn) {
          return yield* new CertificateUnexpectedResponse({ message: "CertificateNotFound" });
        }
        if (detail.Status === "ISSUED") {
          return detail;
        }
        if (isTerminalFailure(detail.Status)) {
          if (detail.FailureReason === "CAA_ERROR") {
            return yield* new CertificateCaaError({
              certificateArn,
              domainName: detail.DomainName ?? "",
            });
          }
          return yield* new CertificateOperationFailed({
            message: `Certificate issuance failed with status ${detail.Status}${detail.FailureReason ? ` (${detail.FailureReason})` : ""}`,
          });
        }
        return yield* new CertificateNotReady({ message: "CertificatePendingValidation" });
      }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "CertificateNotReady" && error.message === "CertificatePendingValidation",
      schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)]),
    }),
  );

const isTerminalFailure = (status: acm.CertificateStatus | undefined) =>
  status === "FAILED" || status === "VALIDATION_TIMED_OUT";
