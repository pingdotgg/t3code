import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface RepositoryProps {
  /**
   * Name of the domain that contains the repository. Pass a `Domain`'s
   * `domainName` attribute. Changing the domain replaces the repository.
   */
  domain: string;
  /**
   * AWS account ID that owns the domain, if it differs from the caller's
   * account (cross-account domains).
   */
  domainOwner?: string;
  /**
   * Name of the repository (2-100 chars). If omitted a deterministic physical
   * name is generated. Changing the name replaces the repository.
   */
  repositoryName?: string;
  /**
   * Human-readable description of the repository.
   */
  description?: string;
  /**
   * Names of other repositories in the same domain to configure as upstream
   * sources. Requests fall through to upstreams (and then any external
   * connection) on a cache miss.
   */
  upstreams?: string[];
  /**
   * A single external connection (e.g. `public:npmjs`, `public:pypi`,
   * `public:maven-central`) to a public package registry. AWS allows at most
   * one external connection per repository.
   */
  externalConnection?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface Repository extends Resource<
  "AWS.CodeArtifact.Repository",
  RepositoryProps,
  {
    /** Physical name of the repository. */
    repositoryName: string;
    /** ARN of the repository. */
    repositoryArn: string;
    /** Name of the domain containing the repository. */
    domainName: string;
    /** AWS account ID that owns the containing domain. */
    domainOwner: string;
    /** AWS account that manages the repository resource. */
    administratorAccount: string;
  },
  never,
  Providers
> {}

/**
 * An AWS CodeArtifact repository — a package store inside a
 * {@link Domain}. Repositories host packages (npm, PyPI, Maven, NuGet, etc.)
 * and can chain to upstream repositories and a single external connection to a
 * public registry.
 *
 * @resource
 * @section Creating a Repository
 * @example Basic Repository
 * ```typescript
 * const domain = yield* CodeArtifact.Domain("packages", {});
 * const repo = yield* CodeArtifact.Repository("npm-store", {
 *   domain: domain.domainName,
 * });
 * ```
 *
 * @example Repository with an external connection to npmjs
 * ```typescript
 * const repo = yield* CodeArtifact.Repository("npm-store", {
 *   domain: domain.domainName,
 *   description: "Proxy of the public npm registry",
 *   externalConnection: "public:npmjs",
 * });
 * ```
 *
 * @example Repository with an upstream
 * ```typescript
 * const shared = yield* CodeArtifact.Repository("shared", {
 *   domain: domain.domainName,
 * });
 * const app = yield* CodeArtifact.Repository("app", {
 *   domain: domain.domainName,
 *   upstreams: [shared.repositoryName],
 * });
 * ```
 */
export const Repository = Resource<Repository>("AWS.CodeArtifact.Repository");

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

const upstreamNames = (
  upstreams: ReadonlyArray<{ repositoryName?: string }> | undefined,
): string[] =>
  (upstreams ?? [])
    .map((u) => u.repositoryName)
    .filter((n): n is string => typeof n === "string");

const externalConnectionNames = (
  connections: ReadonlyArray<{ externalConnectionName?: string }> | undefined,
): string[] =>
  (connections ?? [])
    .map((c) => c.externalConnectionName)
    .filter((n): n is string => typeof n === "string");

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export const RepositoryProvider = () =>
  Provider.effect(
    Repository,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<RepositoryProps>) =>
        props.repositoryName
          ? Effect.succeed(props.repositoryName)
          : createPhysicalName({ id, maxLength: 100 });

      const getRepository = Effect.fn(function* (
        domain: string,
        domainOwner: string | undefined,
        name: string,
      ) {
        const response = yield* codeartifact
          .describeRepository({ domain, domainOwner, repository: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.repository;
      });

      const toAttrs = (
        repository: codeartifact.RepositoryDescription,
        name: string,
        domain: string,
      ) => ({
        repositoryName: repository.name ?? name,
        repositoryArn: repository.arn!,
        domainName: repository.domainName ?? domain,
        domainOwner: repository.domainOwner ?? "",
        administratorAccount: repository.administratorAccount ?? "",
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
        stables: ["repositoryName", "repositoryArn", "domainName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // The containing domain is immutable — replace on change.
          if (
            (news?.domain ?? undefined) !== (olds?.domain ?? undefined) ||
            (news?.domainOwner ?? undefined) !==
              (olds?.domainOwner ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.repositoryName ?? (yield* toName(id, olds ?? {}));
          const domain = output?.domainName ?? olds?.domain;
          if (domain === undefined) return undefined;
          const repository = yield* getRepository(
            domain,
            olds?.domainOwner,
            name,
          );
          if (repository?.arn === undefined) return undefined;
          const attrs = toAttrs(repository, name, domain);
          const tags = yield* codeartifact
            .listTagsForResource({ resourceArn: attrs.repositoryArn })
            .pipe(
              Effect.map((res) => toTagRecord(res.tags)),
              Effect.catch(() => Effect.succeed({})),
            );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.repositoryName ?? (yield* toName(id, news));
          const domain = news.domain;
          const domainOwner = news.domainOwner;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredUpstreams = news.upstreams ?? [];

          // 1. Observe — cloud state is authoritative.
          let observed = yield* getRepository(domain, domainOwner, name);

          // 2. Ensure — create if missing. Tolerate a concurrent-create race.
          if (observed?.arn === undefined) {
            observed = yield* codeartifact
              .createRepository({
                domain,
                domainOwner,
                repository: name,
                description: news.description,
                upstreams: desiredUpstreams.map((repositoryName) => ({
                  repositoryName,
                })),
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              })
              .pipe(
                Effect.map((res) => res.repository),
                Effect.catchTag("ConflictException", () =>
                  getRepository(domain, domainOwner, name),
                ),
              );
            if (observed?.arn === undefined) {
              observed = yield* getRepository(domain, domainOwner, name);
            }
          } else {
            // 3a. Sync description + upstreams via updateRepository if they drift.
            const descChanged =
              (news.description ?? undefined) !==
              (observed.description ?? undefined);
            const upstreamsChanged = !sameSet(
              desiredUpstreams,
              upstreamNames(observed.upstreams),
            );
            if (descChanged || upstreamsChanged) {
              observed = yield* codeartifact
                .updateRepository({
                  domain,
                  domainOwner,
                  repository: name,
                  description: news.description,
                  upstreams: desiredUpstreams.map((repositoryName) => ({
                    repositoryName,
                  })),
                })
                .pipe(Effect.map((res) => res.repository ?? observed));
            }
          }

          // 3b. Sync the external connection — AWS allows at most one.
          const desiredConn = news.externalConnection;
          const currentConns = externalConnectionNames(
            observed!.externalConnections,
          );
          for (const conn of currentConns) {
            if (conn !== desiredConn) {
              yield* codeartifact.disassociateExternalConnection({
                domain,
                domainOwner,
                repository: name,
                externalConnection: conn,
              });
            }
          }
          if (
            desiredConn !== undefined &&
            !currentConns.includes(desiredConn)
          ) {
            observed = yield* codeartifact
              .associateExternalConnection({
                domain,
                domainOwner,
                repository: name,
                externalConnection: desiredConn,
              })
              .pipe(Effect.map((res) => res.repository ?? observed));
          }

          // 3c. Sync tags — diff against OBSERVED cloud tags.
          yield* syncTags(observed!.arn!, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(observed!, name, domain);
        }),

        delete: Effect.fn(function* ({ output, olds }) {
          yield* codeartifact
            .deleteRepository({
              domain: output.domainName,
              domainOwner: output.domainOwner || olds?.domainOwner,
              repository: output.repositoryName,
            })
            .pipe(
              // Deleting a downstream repository propagates eventually — a
              // shared upstream deleted right after can transiently fail with
              // "being used as an upstream repository".
              Effect.retry({
                while: (e): boolean => e._tag === "ConflictException",
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Repositories are scoped to a domain; there is no global enumeration
        // without knowing the domain, so list() returns an empty set.
        list: () => Effect.succeed([]),
      };
    }),
  );
