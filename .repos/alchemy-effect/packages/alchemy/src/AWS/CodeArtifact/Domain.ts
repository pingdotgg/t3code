import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface DomainProps {
  /**
   * Name of the domain (2-50 chars, lowercase letters, digits and hyphens).
   * If omitted a deterministic physical name is generated. Changing the name
   * replaces the domain.
   */
  domainName?: string;
  /**
   * ARN of a KMS key used to encrypt assets in the domain. Defaults to an
   * AWS-managed key. Immutable — changing it replaces the domain.
   */
  encryptionKey?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface Domain extends Resource<
  "AWS.CodeArtifact.Domain",
  DomainProps,
  {
    /** Physical name of the domain. */
    domainName: string;
    /** ARN of the domain. */
    domainArn: string;
    /** AWS account ID that owns the domain. */
    owner: string;
    /** Domain status (`Active` or `Deleted`). */
    status: string;
    /** ARN of the KMS key used to encrypt assets in the domain. */
    encryptionKey: string;
    /** ARN of the S3 bucket backing the domain's asset storage. */
    s3BucketArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS CodeArtifact domain — the top-level container that groups a set of
 * package repositories and provides a single point for encryption, ownership
 * and cross-account access control.
 *
 * @resource
 * @section Creating a Domain
 * @example Basic Domain
 * ```typescript
 * const domain = yield* CodeArtifact.Domain("packages", {});
 * ```
 *
 * @example Domain with a customer-managed KMS key
 * ```typescript
 * const domain = yield* CodeArtifact.Domain("packages", {
 *   domainName: "my-org",
 *   encryptionKey: key.keyArn,
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const Domain = Resource<Domain>("AWS.CodeArtifact.Domain");

/** Convert a CodeArtifact wire tag list into a plain record. */
const toTagRecord = (
  tags: ReadonlyArray<{ key?: string; value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { key: string; value: string } =>
          typeof tag.key === "string" && typeof tag.value === "string",
      )
      .map((tag) => [tag.key, tag.value]),
  );

export const DomainProvider = () =>
  Provider.effect(
    Domain,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<DomainProps>) =>
        props.domainName
          ? Effect.succeed(props.domainName)
          : createPhysicalName({ id, maxLength: 50 });

      const getDomain = Effect.fn(function* (name: string) {
        const response = yield* codeartifact
          .describeDomain({ domain: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.domain;
      });

      const toAttrs = (
        domain: codeartifact.DomainDescription,
        name: string,
      ) => ({
        domainName: domain.name ?? name,
        domainArn: domain.arn!,
        owner: domain.owner ?? "",
        status: domain.status ?? "Active",
        encryptionKey: domain.encryptionKey ?? "",
        s3BucketArn: domain.s3BucketArn ?? "",
      });

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const observed = yield* codeartifact
          .listTagsForResource({ resourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const { removed, upsert } = diffTags(
          toTagRecord(observed?.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* codeartifact.tagResource({
            resourceArn: arn,
            tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
          });
        }
        if (removed.length > 0) {
          yield* codeartifact.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: ["domainName", "domainArn", "owner"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // The encryption key is immutable — replace on change.
          if (
            (news?.encryptionKey ?? undefined) !==
            (olds?.encryptionKey ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.domainName ?? (yield* toName(id, olds ?? {}));
          const domain = yield* getDomain(name);
          if (domain?.arn === undefined) return undefined;
          const attrs = toAttrs(domain, name);
          const tags = yield* codeartifact
            .listTagsForResource({ resourceArn: attrs.domainArn })
            .pipe(
              Effect.map((res) => toTagRecord(res.tags)),
              Effect.catch(() => Effect.succeed({})),
            );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.domainName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* getDomain(name);

          // 2. Ensure — domains are immutable; create if missing. Tolerate a
          // concurrent-create race as an existing domain, and retry through
          // the deletion-propagation window where a freshly deleted domain
          // still rejects creates (ConflictException) while describeDomain
          // already reports it gone.
          if (observed?.arn === undefined) {
            observed = yield* codeartifact
              .createDomain({
                domain: name,
                encryptionKey: news.encryptionKey,
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              })
              .pipe(
                Effect.map((res) => res.domain),
                Effect.catchTag("ConflictException", () => getDomain(name)),
                Effect.repeat({
                  until: (domain): boolean => domain?.arn !== undefined,
                  schedule: Schedule.spaced("2 seconds"),
                  times: 10,
                }),
              );
          }

          // 3. Sync tags — diff against OBSERVED cloud tags.
          yield* syncTags(observed!.arn!, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(observed!, name);
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteDomain is idempotent — deleting a non-existent domain
          // succeeds (its typed error union has no not-found variant). A
          // domain whose repositories were deleted moments earlier can
          // transiently Conflict while those deletions propagate.
          yield* codeartifact.deleteDomain({ domain: output.domainName }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "ConflictException",
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
          );
        }),

        list: () =>
          codeartifact.listDomains.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.domains ?? [])
                .flatMap((d) =>
                  d.arn !== undefined && d.name !== undefined
                    ? [
                        {
                          domainName: d.name,
                          domainArn: d.arn,
                          owner: d.owner ?? "",
                          status: d.status ?? "Active",
                          encryptionKey: d.encryptionKey ?? "",
                          s3BucketArn: "",
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
