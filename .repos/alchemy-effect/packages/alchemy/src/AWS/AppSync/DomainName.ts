import * as appsync from "@distilled.cloud/aws/appsync";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { Unowned } from "../../AdoptPolicy.ts";
import type { Providers } from "../Providers.ts";
import {
  retryConcurrentModification,
  syncAppSyncTags,
  tagRecord,
} from "./common.ts";

export interface DomainNameProps {
  /**
   * The custom domain name, e.g. `api.example.com`. Changing it triggers
   * a replacement.
   */
  domainName: string;
  /**
   * ARN of an ACM certificate covering the domain. AppSync custom domains
   * are CloudFront-backed, so the certificate **must live in us-east-1**.
   * Changing it triggers a replacement.
   */
  certificateArn: string;
  /** Description of the domain. */
  description?: string;
  /** Tags to apply. Merged with internal Alchemy tags. */
  tags?: Record<string, string>;
}

export interface AppSyncDomainName extends Resource<
  "AWS.AppSync.DomainName",
  DomainNameProps,
  {
    /** The custom domain name. */
    domainName: string;
    /** The domain name ARN. */
    domainNameArn: string | undefined;
    /** The certificate ARN. */
    certificateArn: string;
    /**
     * The CloudFront target (`dxxxx.cloudfront.net`) to point a CNAME /
     * Route53 alias at.
     */
    appsyncDomainName: string | undefined;
    /** The Route53 hosted zone ID for alias records. */
    hostedZoneId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom domain name for AppSync GraphQL APIs.
 *
 * Requires an ACM certificate **in us-east-1** (the domain is
 * CloudFront-backed). Attach an API with {@link ApiAssociation} and point
 * DNS at the `appsyncDomainName` attribute.
 * @resource
 * @section Creating Custom Domains
 * @example Custom domain + API association
 * ```typescript
 * const domain = yield* AppSync.DomainName("Domain", {
 *   domainName: "api.example.com",
 *   certificateArn: usEast1Cert.certificateArn,
 * });
 * yield* AppSync.ApiAssociation("Assoc", { domain, api });
 * // CNAME api.example.com → domain.appsyncDomainName
 * ```
 */
export const DomainName = Resource<AppSyncDomainName>("AWS.AppSync.DomainName");

export const DomainNameProvider = () =>
  Provider.effect(
    DomainName,
    Effect.gen(function* () {
      const getDomainSafe = (domainName: string) =>
        appsync.getDomainName({ domainName }).pipe(
          Effect.map((response) => response.domainNameConfig),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      const toAttributes = (
        config: appsync.DomainNameConfig,
      ): AppSyncDomainName["Attributes"] => ({
        domainName: config.domainName!,
        domainNameArn: config.domainNameArn,
        certificateArn: config.certificateArn!,
        appsyncDomainName: config.appsyncDomainName,
        hostedZoneId: config.hostedZoneId,
      });

      return DomainName.Provider.of({
        stables: [
          "domainName",
          "domainNameArn",
          "appsyncDomainName",
          "hostedZoneId",
        ],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* appsync.listDomainNames
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.domainNameConfigs ?? [])
              .filter((config) => config.domainName != null)
              .map(toAttributes);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const domainName = output?.domainName ?? olds?.domainName;
          if (domainName === undefined) return undefined;
          const config = yield* getDomainSafe(domainName);
          if (config?.domainName == null) return undefined;
          const attrs = toAttributes(config);
          return (yield* hasAlchemyTags(id, tagRecord(config.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.domainName !== olds.domainName ||
            news.certificateArn !== olds.certificateArn
          ) {
            return { action: "replace" } as const;
          }
          // description/tags converge via update
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let observed = yield* getDomainSafe(news.domainName);

          if (observed?.domainName == null) {
            // 2. ENSURE
            const created = yield* retryConcurrentModification(
              appsync.createDomainName({
                domainName: news.domainName,
                certificateArn: news.certificateArn,
                description: news.description,
                tags: desiredTags,
              }),
            );
            observed = created.domainNameConfig!;
            yield* session.note(`Created domain ${news.domainName}`);
          } else if (
            news.description !== undefined &&
            observed.description !== news.description
          ) {
            // 3. SYNC
            const updated = yield* retryConcurrentModification(
              appsync.updateDomainName({
                domainName: news.domainName,
                description: news.description,
              }),
            );
            observed = updated.domainNameConfig ?? observed;
            yield* session.note(`Updated domain ${news.domainName}`);
          }

          // 3b. SYNC TAGS — against OBSERVED cloud tags.
          if (observed.domainNameArn !== undefined) {
            yield* syncAppSyncTags({
              resourceArn: observed.domainNameArn,
              oldTags: tagRecord(observed.tags),
              newTags: desiredTags,
            });
          }

          yield* session.note(news.domainName);
          return toAttributes(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A domain with a live association cannot be deleted; the
          // association resource is destroyed first (dependency order),
          // but the detach itself is eventually consistent — the
          // ConcurrentModification retry rides that out.
          yield* retryConcurrentModification(
            appsync
              .deleteDomainName({ domainName: output.domainName })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
        }),
      });
    }),
  );
