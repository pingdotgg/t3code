import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, tagRecord } from "../../Tags.ts";

import { syncTags } from "./common.ts";

export interface DomainNameProps {
  /** The custom domain name (e.g. `api.example.com`). */
  domainName: string;
  /** Display name of a self-managed edge certificate. */
  certificateName?: string;
  /** PEM body of a self-managed edge certificate. */
  certificateBody?: string;
  /**
   * The private key of the server certificate (self-managed certificates).
   * Secret key material — wrap with `Redacted.make` so state encoding
   * preserves redaction.
   */
  certificatePrivateKey?: Redacted.Redacted<string>;
  /** PEM chain of a self-managed edge certificate. */
  certificateChain?: string;
  /** ARN of an ACM certificate for EDGE endpoints (must live in us-east-1). */
  certificateArn?: string;
  /** Display name of the regional certificate. */
  regionalCertificateName?: string;
  /** ARN of an ACM certificate for REGIONAL endpoints (same region as the API). */
  regionalCertificateArn?: string;
  /** Endpoint type for the domain (EDGE, REGIONAL, or PRIVATE). */
  endpointConfiguration?: ag.EndpointConfiguration;
  /**
   * Minimum TLS version served (e.g. `TLS_1_2`).
   * @default "TLS_1_2"
   */
  securityPolicy?: ag.SecurityPolicy;
  /** Access mode of the domain name endpoint. */
  endpointAccessMode?: ag.EndpointAccessMode;
  /** Mutual TLS (client certificate) authentication configuration. */
  mutualTlsAuthentication?: ag.MutualTlsAuthenticationInput;
  /** ARN of the certificate proving domain ownership when mutual TLS is enabled. */
  ownershipVerificationCertificateArn?: string;
  /** Resource policy (JSON) for private custom domain names. */
  policy?: string;
  /** Routing mode of the domain name (base-path vs routing-rule based). */
  routingMode?: ag.RoutingMode;
  /** User-defined tags for the domain name. */
  tags?: Record<string, string>;
}

/** @resource */
export interface DomainName extends Resource<
  "AWS.ApiGateway.DomainName",
  DomainNameProps,
  {
    domainName: string;
    regionalDomainName: string | undefined;
    regionalHostedZoneId: string | undefined;
    distributionDomainName: string | undefined;
    distributionHostedZoneId: string | undefined;
    domainNameArn: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Custom domain name for an Amazon API Gateway REST API.
 *
 * @section Custom domain
 * @example Regional custom domain
 * ```typescript
 * const domain = yield* ApiGateway.DomainName("ApiDomain", {
 *   domainName: "api.example.com",
 *   regionalCertificateArn: cert.certificateArn,
 *   endpointConfiguration: { types: ["REGIONAL"] },
 *   securityPolicy: "TLS_1_2",
 * });
 * ```
 */
const DomainNameResource = Resource<DomainName>("AWS.ApiGateway.DomainName");

export { DomainNameResource as DomainName };

/** Unwrap an optional redacted secret for the wire / diff comparison. */
const redactedValue = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

const retryDomainNameMutation = Effect.retry({
  while: (e: any) =>
    e._tag === "ConflictException" || e._tag === "TooManyRequestsException",
  schedule: Schedule.spaced("1 second"),
  times: 8,
});

export const DomainNameProvider = () =>
  Provider.effect(
    DomainNameResource,
    Effect.gen(function* () {
      return {
        stables: ["domainName"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as DomainNameProps;
          if (news.domainName !== olds.domainName) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(news.endpointConfiguration, olds.endpointConfiguration)
          ) {
            return { action: "replace" } as const;
          }
          if (news.endpointAccessMode !== olds.endpointAccessMode) {
            return { action: "replace" } as const;
          }
          if (news.certificateBody !== olds.certificateBody) {
            return { action: "replace" } as const;
          }
          if (
            redactedValue(news.certificatePrivateKey) !==
            redactedValue(olds.certificatePrivateKey)
          ) {
            return { action: "replace" } as const;
          }
          if (news.certificateChain !== olds.certificateChain) {
            return { action: "replace" } as const;
          }
          if (news.certificateName !== olds.certificateName) {
            return { action: "replace" } as const;
          }
          if (news.regionalCertificateName !== olds.regionalCertificateName) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              news.mutualTlsAuthentication,
              olds.mutualTlsAuthentication,
            )
          ) {
            return { action: "replace" } as const;
          }
          if (news.policy !== olds.policy) {
            return { action: "replace" } as const;
          }
          if (news.routingMode !== olds.routingMode) {
            return { action: "replace" } as const;
          }
          if (
            news.ownershipVerificationCertificateArn !==
            olds.ownershipVerificationCertificateArn
          ) {
            return { action: "replace" } as const;
          }
        }),
        list: () =>
          ag.getDomainNames.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.items ?? [])
                  .filter(
                    (d): d is ag.DomainName & { domainName: string } =>
                      d.domainName != null,
                  )
                  .map((d) => ({
                    domainName: d.domainName,
                    regionalDomainName: d.regionalDomainName,
                    regionalHostedZoneId: d.regionalHostedZoneId,
                    distributionDomainName: d.distributionDomainName,
                    distributionHostedZoneId: d.distributionHostedZoneId,
                    domainNameArn: d.domainNameArn,
                    tags: tagRecord(d.tags),
                  })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ output }) {
          if (!output?.domainName) return undefined;
          const d = yield* ag
            .getDomainName({ domainName: output.domainName })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!d?.domainName) return undefined;
          return {
            domainName: d.domainName,
            regionalDomainName: d.regionalDomainName,
            regionalHostedZoneId: d.regionalHostedZoneId,
            distributionDomainName: d.distributionDomainName,
            distributionHostedZoneId: d.distributionHostedZoneId,
            domainNameArn: d.domainNameArn,
            tags: tagRecord(d.tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("DomainName props were not resolved");
          }
          const news = newsIn as DomainNameProps;
          const domainName = output?.domainName ?? news.domainName;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Observe — fetch the live domain name. Domain names are
          // user-supplied physical names so the lookup key is stable; we
          // never trust `output.tags`/`output.securityPolicy` etc. for
          // diffing, only re-read the cloud state.
          let observed = yield* ag
            .getDomainName({ domainName })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the domain name if it's missing.
          if (!observed?.domainName) {
            yield* ag.createDomainName({
              domainName: news.domainName,
              certificateName: news.certificateName,
              certificateBody: news.certificateBody,
              certificatePrivateKey: redactedValue(news.certificatePrivateKey),
              certificateChain: news.certificateChain,
              certificateArn: news.certificateArn,
              regionalCertificateName: news.regionalCertificateName,
              regionalCertificateArn: news.regionalCertificateArn,
              endpointConfiguration: news.endpointConfiguration,
              tags: desiredTags,
              securityPolicy: news.securityPolicy,
              endpointAccessMode: news.endpointAccessMode,
              mutualTlsAuthentication: news.mutualTlsAuthentication,
              ownershipVerificationCertificateArn:
                news.ownershipVerificationCertificateArn,
              policy: news.policy,
              routingMode: news.routingMode,
            });
            yield* session.note(`Created domain name ${news.domainName}`);
            observed = yield* ag.getDomainName({ domainName });
          }

          // Sync mutable scalar fields — observed ↔ desired patch list.
          const patches: ag.PatchOperation[] = [];
          if (news.securityPolicy !== observed.securityPolicy) {
            patches.push({
              op: news.securityPolicy === undefined ? "remove" : "replace",
              path: "/securityPolicy",
              value: news.securityPolicy,
            });
          }
          if (news.regionalCertificateArn !== observed.regionalCertificateArn) {
            patches.push({
              op:
                news.regionalCertificateArn === undefined
                  ? "remove"
                  : "replace",
              path: "/regionalCertificateArn",
              value: news.regionalCertificateArn,
            });
          }
          if (news.certificateArn !== observed.certificateArn) {
            patches.push({
              op: news.certificateArn === undefined ? "remove" : "replace",
              path: "/certificateArn",
              value: news.certificateArn,
            });
          }
          if (patches.length > 0) {
            // Domain name mutations can briefly conflict while API Gateway
            // propagates certificate, policy, or routing changes.
            yield* ag
              .updateDomainName({
                domainName,
                patchOperations: patches,
              })
              .pipe(retryDomainNameMutation);
          }

          // Sync tags — diff observed cloud tags against desired so adoption
          // converges without fighting whatever was already there.
          const observedTags = tagRecord(observed.tags);
          if (!deepEqual(observedTags, desiredTags) && observed.domainNameArn) {
            yield* syncTags({
              resourceArn: observed.domainNameArn,
              oldTags: observedTags,
              newTags: desiredTags,
            });
          }

          yield* session.note(`Reconciled domain name ${domainName}`);
          const final = yield* ag.getDomainName({ domainName });
          return {
            domainName: final.domainName!,
            regionalDomainName: final.regionalDomainName,
            regionalHostedZoneId: final.regionalHostedZoneId,
            distributionDomainName: final.distributionDomainName,
            distributionHostedZoneId: final.distributionHostedZoneId,
            domainNameArn: final.domainNameArn,
            tags: tagRecord(final.tags),
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag.deleteDomainName({ domainName: output.domainName }).pipe(
            Effect.catchTag("NotFoundException", () => Effect.void),
            retryDomainNameMutation,
          );
          yield* session.note(`Deleted domain name ${output.domainName}`);
        }),
      };
    }),
  );
