import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { fetchObservedTags, syncResourceTags, toTagList } from "./internal.ts";

export interface RepositoryLinkProps {
  /**
   * ARN of the connection to the external provider. The connection must be
   * in the `AVAILABLE` state (its OAuth handshake completed in the console).
   */
  connectionArn: string;
  /**
   * Owner ID of the repository — the GitHub organization/user or GitLab
   * group/user that owns the repository. Changing the owner replaces the
   * link.
   */
  ownerId: string;
  /**
   * Name of the repository to link. Changing the repository replaces the
   * link.
   */
  repositoryName: string;
  /**
   * ARN of the KMS key used to encrypt the repository link's sync content.
   */
  encryptionKeyArn?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface RepositoryLink extends Resource<
  "AWS.CodeConnections.RepositoryLink",
  RepositoryLinkProps,
  {
    /** Unique ID of the repository link (used by sync operations). */
    repositoryLinkId: string;
    /** ARN of the repository link. */
    repositoryLinkArn: string;
    /** ARN of the connection the link authenticates through. */
    connectionArn: string;
    /** Owner ID of the linked repository. */
    ownerId: string;
    /** Name of the linked repository. */
    repositoryName: string;
    /** The source provider (`GitHub`, `GitLab`, ...). */
    providerType: string;
    /** ARN of the KMS key encrypting the link's sync content, if any. */
    encryptionKeyArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS CodeConnections repository link — associates a connection with a
 * specific external Git repository so Git sync can monitor and sync changes
 * (e.g. CloudFormation git sync).
 *
 * Requires a connection in the `AVAILABLE` state; the connection's OAuth
 * handshake is a one-time **manual** console step.
 * @resource
 * @section Linking a Repository
 * @example Link a GitHub Repository
 * ```typescript
 * const link = yield* CodeConnections.RepositoryLink("Repo", {
 *   connectionArn: connection.connectionArn,
 *   ownerId: "my-github-org",
 *   repositoryName: "my-repo",
 * });
 * ```
 *
 * @example Encrypted Repository Link
 * ```typescript
 * const link = yield* CodeConnections.RepositoryLink("Repo", {
 *   connectionArn: connection.connectionArn,
 *   ownerId: "my-github-org",
 *   repositoryName: "my-repo",
 *   encryptionKeyArn: key.keyArn,
 * });
 * ```
 */
export const RepositoryLink = Resource<RepositoryLink>(
  "AWS.CodeConnections.RepositoryLink",
);

export const RepositoryLinkProvider = () =>
  Provider.effect(
    RepositoryLink,
    Effect.gen(function* () {
      /** Read a repository link by ID; a missing link reads as absent. */
      const getById = Effect.fn(function* (id: string) {
        const response = yield* codeconnections
          .getRepositoryLink({ RepositoryLinkId: id })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.RepositoryLinkInfo;
      });

      /**
       * Find a repository link by its identity — owner + repository name
       * (getRepositoryLink only accepts an ID).
       */
      const findByIdentity = Effect.fn(function* (
        ownerId: string,
        repositoryName: string,
      ) {
        const links = yield* codeconnections.listRepositoryLinks.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.RepositoryLinks ?? []),
          ),
        );
        return links.find(
          (link) =>
            link.OwnerId === ownerId && link.RepositoryName === repositoryName,
        );
      });

      const toAttrs = (link: codeconnections.RepositoryLinkInfo) => ({
        repositoryLinkId: link.RepositoryLinkId,
        repositoryLinkArn: link.RepositoryLinkArn,
        connectionArn: link.ConnectionArn,
        ownerId: link.OwnerId,
        repositoryName: link.RepositoryName,
        providerType: link.ProviderType ?? "",
        encryptionKeyArn: link.EncryptionKeyArn,
      });

      return {
        stables: [
          "repositoryLinkId",
          "repositoryLinkArn",
          "ownerId",
          "repositoryName",
          "providerType",
        ],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // The linked repository is the link's identity — replace on change.
          // Connection and encryption key are mutable via UpdateRepositoryLink.
          if (
            (news?.ownerId ?? undefined) !== (olds?.ownerId ?? undefined) ||
            (news?.repositoryName ?? undefined) !==
              (olds?.repositoryName ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const link = output?.repositoryLinkId
            ? yield* getById(output.repositoryLinkId)
            : olds?.ownerId && olds?.repositoryName
              ? yield* findByIdentity(olds.ownerId, olds.repositoryName)
              : undefined;
          if (link === undefined) return undefined;
          const attrs = toAttrs(link);
          const tags = yield* fetchObservedTags(attrs.repositoryLinkArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = output?.repositoryLinkId
            ? yield* getById(output.repositoryLinkId)
            : yield* findByIdentity(news.ownerId, news.repositoryName);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            observed = yield* codeconnections
              .createRepositoryLink({
                ConnectionArn: news.connectionArn,
                OwnerId: news.ownerId,
                RepositoryName: news.repositoryName,
                EncryptionKeyArn: news.encryptionKeyArn,
                Tags: toTagList(desiredTags),
              })
              .pipe(
                Effect.map((res) => res.RepositoryLinkInfo),
                Effect.catchTag("ResourceAlreadyExistsException", (error) =>
                  findByIdentity(news.ownerId, news.repositoryName).pipe(
                    Effect.flatMap((link) =>
                      link === undefined
                        ? // The race lost and the winner is not visible yet —
                          // surface the typed conflict; the engine retries.
                          Effect.fail(error)
                        : Effect.succeed(link),
                    ),
                  ),
                ),
              );
          }

          // 3. Sync — connection + encryption key, diffed against OBSERVED
          // cloud state; skip the API entirely on no-op.
          if (
            observed.ConnectionArn !== news.connectionArn ||
            (observed.EncryptionKeyArn ?? undefined) !==
              (news.encryptionKeyArn ?? undefined)
          ) {
            const updated = yield* codeconnections.updateRepositoryLink({
              RepositoryLinkId: observed.RepositoryLinkId,
              ConnectionArn: news.connectionArn,
              EncryptionKeyArn: news.encryptionKeyArn,
            });
            observed = updated.RepositoryLinkInfo;
          }

          // 4. Sync tags — diff against OBSERVED cloud tags.
          yield* syncResourceTags(observed.RepositoryLinkArn, desiredTags);

          yield* session.note(`${news.ownerId}/${news.repositoryName}`);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Sync configurations on the link must be deleted first — retry
          // the dependency violation while downstream deletions land.
          yield* codeconnections
            .deleteRepositoryLink({
              RepositoryLinkId: output.repositoryLinkId,
            })
            .pipe(
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "SyncConfigurationStillExistsException",
                schedule: Schedule.exponential("2 seconds"),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          codeconnections.listRepositoryLinks.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.RepositoryLinks ?? [])
                .map((link) => ({
                  repositoryLinkId: link.RepositoryLinkId,
                  repositoryLinkArn: link.RepositoryLinkArn,
                  connectionArn: link.ConnectionArn,
                  ownerId: link.OwnerId,
                  repositoryName: link.RepositoryName,
                  providerType: link.ProviderType ?? "",
                  encryptionKeyArn: link.EncryptionKeyArn,
                })),
            ),
          ),
      };
    }),
  );
