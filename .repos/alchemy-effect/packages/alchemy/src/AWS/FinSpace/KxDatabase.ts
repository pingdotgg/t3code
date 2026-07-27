import * as finspace from "@distilled.cloud/aws/finspace";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface KxDatabaseProps {
  /**
   * Identifier of the kdb environment the database lives in. Changing it
   * replaces the database.
   */
  environmentId: string;
  /**
   * Name of the kdb database. Changing it replaces the database.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  databaseName?: string;
  /**
   * A description of the database.
   */
  description?: string;
  /**
   * Tags to associate with the database.
   */
  tags?: Record<string, string>;
}

export interface KxDatabase extends Resource<
  "AWS.FinSpace.KxDatabase",
  KxDatabaseProps,
  {
    /**
     * Identifier of the kdb environment the database lives in.
     */
    environmentId: string;
    /**
     * The database's name.
     */
    databaseName: string;
    /**
     * ARN of the database.
     */
    databaseArn: string;
    /**
     * The database's description.
     */
    description: string | undefined;
    /**
     * Current tags reported for the database.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A kdb database inside an Amazon FinSpace Managed kdb environment — the
 * versioned, changeset-based store that kdb clusters mount and query.
 *
 * @resource
 * @section Creating kdb Databases
 * @example Basic kdb Database
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const env = yield* AWS.FinSpace.KxEnvironment("Kdb", { kmsKeyId });
 * const db = yield* AWS.FinSpace.KxDatabase("Ticks", {
 *   environmentId: env.environmentId,
 *   description: "tick data",
 * });
 * ```
 */
export const KxDatabase = Resource<KxDatabase>("AWS.FinSpace.KxDatabase");

const createDatabaseName = (
  id: string,
  props: { databaseName?: string | undefined },
) =>
  props.databaseName
    ? Effect.succeed(props.databaseName)
    : createPhysicalName({ id, maxLength: 63 });

const fetchDatabaseTags = Effect.fn(function* (arn: string) {
  const response = yield* finspace
    .listTagsForResource({ resourceArn: arn })
    .pipe(
      Effect.catchTag(
        ["ResourceNotFoundException", "InvalidRequestException"],
        () => Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    Object.entries(response?.tags ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );
});

const readDatabase = Effect.fn(function* (
  environmentId: string,
  databaseName: string,
) {
  const response = yield* finspace
    .getKxDatabase({ environmentId, databaseName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!response) return undefined;
  const databaseArn = response.databaseArn ?? "";
  const attrs: KxDatabase["Attributes"] = {
    environmentId: response.environmentId ?? environmentId,
    databaseName: response.databaseName ?? databaseName,
    databaseArn,
    description: response.description,
    tags: databaseArn ? yield* fetchDatabaseTags(databaseArn) : {},
  };
  return attrs;
});

export const KxDatabaseProvider = () =>
  Provider.effect(
    KxDatabase,
    Effect.gen(function* () {
      return {
        stables: ["environmentId", "databaseName", "databaseArn"],
        // Databases are keyed by their parent kdb environment — there is no
        // account-wide enumeration without an environment id.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const environmentId = output?.environmentId ?? olds?.environmentId;
          if (environmentId === undefined) return undefined;
          const databaseName =
            output?.databaseName ?? (yield* createDatabaseName(id, olds ?? {}));
          const attrs = yield* readDatabase(environmentId, databaseName);
          if (!attrs) return undefined;
          return (yield* hasAlchemyTags(id, attrs.tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          const oldName = yield* createDatabaseName(id, olds);
          const newName = yield* createDatabaseName(id, news);
          if (
            olds.environmentId !== news.environmentId ||
            oldName !== newName
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("FinSpace KxDatabase requires props"),
            );
          }
          const environmentId = news.environmentId;
          const databaseName =
            output?.databaseName ?? (yield* createDatabaseName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          // One idempotency token per reconcile, reused across create+update.
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());

          // Observe — cloud state is authoritative.
          let attrs = yield* readDatabase(environmentId, databaseName);

          // Ensure — create if missing; tolerate an AlreadyExists race.
          if (attrs === undefined) {
            yield* finspace
              .createKxDatabase({
                environmentId,
                databaseName,
                description: news.description,
                tags: desiredTags,
                clientToken,
              })
              .pipe(
                Effect.catchTag("ResourceAlreadyExistsException", () =>
                  Effect.succeed(undefined),
                ),
              );
            yield* session.note(`Created kdb database ${databaseName}`);
            attrs = yield* readDatabase(environmentId, databaseName);
            if (attrs === undefined) {
              return yield* Effect.fail(
                new Error(
                  `failed to read created kdb database ${databaseName}`,
                ),
              );
            }
          }

          // Sync description — only call UpdateKxDatabase on drift.
          if (
            news.description !== undefined &&
            news.description !== attrs.description
          ) {
            yield* finspace.updateKxDatabase({
              environmentId,
              databaseName,
              description: news.description,
              clientToken,
            });
            yield* session.note(`Updated kdb database ${databaseName}`);
          }

          // Sync tags — diff against observed cloud tags.
          if (attrs.databaseArn) {
            const { removed, upsert } = diffTags(attrs.tags, desiredTags);
            if (removed.length > 0) {
              yield* finspace.untagResource({
                resourceArn: attrs.databaseArn,
                tagKeys: removed,
              });
            }
            if (upsert.length > 0) {
              yield* finspace.tagResource({
                resourceArn: attrs.databaseArn,
                tags: Object.fromEntries(
                  upsert.map(({ Key, Value }) => [Key, Value]),
                ),
              });
            }
          }

          yield* session.note(attrs.databaseArn);

          const final = yield* readDatabase(environmentId, databaseName);
          if (!final) {
            return yield* Effect.fail(
              new Error(
                `failed to read reconciled kdb database ${databaseName}`,
              ),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());
          yield* finspace
            .deleteKxDatabase({
              environmentId: output.environmentId,
              databaseName: output.databaseName,
              clientToken,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
