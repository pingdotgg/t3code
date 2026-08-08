import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";

/**
 * The vector-store and embedding configuration of a knowledge base. Passed
 * through to the Bedrock API unchanged — see the AWS SDK
 * `KnowledgeBaseConfiguration` shape. The common case is a `VECTOR` type with
 * `vectorKnowledgeBaseConfiguration.embeddingModelArn` set.
 */
export type KnowledgeBaseConfiguration = bedrock.KnowledgeBaseConfiguration;

/**
 * The backing vector store (OpenSearch Serverless, Pinecone, RDS/pgvector,
 * S3 Vectors, ...). Passed through to the Bedrock API unchanged — see the AWS
 * SDK `StorageConfiguration` shape. Omit for a managed vector store.
 */
export type StorageConfiguration = bedrock.StorageConfiguration;

export interface KnowledgeBaseProps {
  /**
   * Name of the knowledge base (1-100 characters). If omitted, a
   * deterministic physical name is generated from the app, stage, and
   * logical ID. Changing the name triggers a replacement.
   */
  name?: string;
  /**
   * A description of the knowledge base.
   */
  description?: string;
  /**
   * The ARN of an IAM role Bedrock assumes to access the embedding model,
   * the vector store, and (via data sources) the source data. Must trust
   * `bedrock.amazonaws.com`.
   */
  roleArn: string;
  /**
   * The embedding + vector-store type configuration. Changing the type
   * triggers a replacement.
   */
  knowledgeBaseConfiguration: KnowledgeBaseConfiguration;
  /**
   * The backing vector store. Omit for a Bedrock-managed store.
   */
  storageConfiguration?: StorageConfiguration;
  /**
   * Tags to apply to the knowledge base. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface KnowledgeBase extends Resource<
  "AWS.Bedrock.KnowledgeBase",
  KnowledgeBaseProps,
  {
    /**
     * The unique identifier of the knowledge base.
     */
    knowledgeBaseId: string;
    /**
     * The ARN of the knowledge base.
     */
    knowledgeBaseArn: string;
    /**
     * Name of the knowledge base.
     */
    name: string;
    /**
     * The ARN of the execution role the knowledge base assumes to access the
     * embedding model and vector store.
     */
    roleArn: string;
  }
> {}

/**
 * An Amazon Bedrock knowledge base — a managed RAG index that embeds source
 * documents into a vector store for retrieval.
 *
 * `KnowledgeBase` owns the index configuration; attach one or more
 * {@link DataSource}s (e.g. an S3 bucket) to feed it documents, then trigger
 * ingestion. Query it at runtime with the {@link Retrieve} and
 * {@link RetrieveAndGenerate} bindings, or attach it to an {@link Agent}.
 *
 * The `roleArn` must grant Bedrock access to the embedding model, the vector
 * store, and the source data. The vector store (`storageConfiguration`) must
 * already exist — provision an OpenSearch Serverless collection (with a
 * vector index) or another supported store first.
 *
 * @resource
 * @section Creating Knowledge Bases
 * @example OpenSearch Serverless Backed Knowledge Base
 * ```typescript
 * import * as Bedrock from "alchemy/AWS/Bedrock";
 *
 * const kb = yield* Bedrock.KnowledgeBase("docs", {
 *   roleArn: role.roleArn,
 *   knowledgeBaseConfiguration: {
 *     type: "VECTOR",
 *     vectorKnowledgeBaseConfiguration: {
 *       embeddingModelArn:
 *         "arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-text-v2:0",
 *     },
 *   },
 *   storageConfiguration: {
 *     type: "OPENSEARCH_SERVERLESS",
 *     opensearchServerlessConfiguration: {
 *       collectionArn: collection.arn,
 *       vectorIndexName: "bedrock-index",
 *       fieldMapping: {
 *         vectorField: "bedrock-vector",
 *         textField: "bedrock-text",
 *         metadataField: "bedrock-metadata",
 *       },
 *     },
 *   },
 * });
 * ```
 */
export const KnowledgeBase = Resource<KnowledgeBase>(
  "AWS.Bedrock.KnowledgeBase",
);

/** KB status values indicating an in-flight transition to wait out. */
const KB_TRANSIENT = new Set(["CREATING", "UPDATING", "DELETING"]);

/**
 * A knowledge base with attached data sources rejects deletion with a
 * `ConflictException` until they are gone (the engine deletes them first, but
 * their teardown is eventually consistent). Bounded retry (~60s), wrapped in
 * an explicitly-typed helper so the `Effect.retry` return type does not widen
 * the provider layer's requirement to `unknown` (see PATTERNS §7).
 */
const retryWhileConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

export const KnowledgeBaseProvider = () =>
  Provider.effect(
    KnowledgeBase,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<KnowledgeBaseProps, "name">,
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const getKbOrUndefined = Effect.fn(function* (knowledgeBaseId: string) {
        return yield* bedrock.getKnowledgeBase({ knowledgeBaseId }).pipe(
          Effect.map((r) => r.knowledgeBase),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const findByName = Effect.fn(function* (name: string) {
        const pages = yield* bedrock.listKnowledgeBases
          .pages({})
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.knowledgeBaseSummaries ?? [])
          .find((s) => s.name === name)?.knowledgeBaseId;
      });

      const fetchObservedTags = Effect.fn(function* (resourceArn: string) {
        return yield* bedrock.listTagsForResource({ resourceArn }).pipe(
          Effect.map((r) => (r.tags ?? {}) as Record<string, string>),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      const waitForSettled = Effect.fn(function* (knowledgeBaseId: string) {
        return yield* bedrock.getKnowledgeBase({ knowledgeBaseId }).pipe(
          Effect.map((r) => r.knowledgeBase),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (kb) => kb === undefined || !KB_TRANSIENT.has(kb.status),
            times: 60,
          }),
        );
      });

      return KnowledgeBase.Provider.of({
        stables: ["knowledgeBaseId", "knowledgeBaseArn", "name"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* bedrock.listKnowledgeBases
              .pages({})
              .pipe(Stream.runCollect);
            const summaries = Array.from(pages).flatMap(
              (page) => page.knowledgeBaseSummaries ?? [],
            );
            const results = yield* Effect.forEach(
              summaries,
              (s) =>
                getKbOrUndefined(s.knowledgeBaseId).pipe(
                  Effect.map((kb) =>
                    kb === undefined
                      ? undefined
                      : {
                          knowledgeBaseId: kb.knowledgeBaseId,
                          knowledgeBaseArn: kb.knowledgeBaseArn,
                          name: kb.name,
                          roleArn: kb.roleArn,
                        },
                  ),
                ),
              { concurrency: 5 },
            );
            return results.filter(
              (r): r is KnowledgeBase["Attributes"] => r !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const kbId =
            output?.knowledgeBaseId ??
            (yield* findByName(
              output?.name ??
                (yield* createName(id, olds ?? ({} as KnowledgeBaseProps))),
            ));
          if (kbId === undefined) return undefined;
          const kb = yield* getKbOrUndefined(kbId);
          if (kb === undefined || kb.status === "DELETING") return undefined;
          const attrs = {
            knowledgeBaseId: kb.knowledgeBaseId,
            knowledgeBaseArn: kb.knowledgeBaseArn,
            name: kb.name,
            roleArn: kb.roleArn,
          };
          const tags = yield* fetchObservedTags(kb.knowledgeBaseArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(
            id,
            olds ?? ({} as KnowledgeBaseProps),
          );
          const newName = yield* createName(
            id,
            news ?? ({} as KnowledgeBaseProps),
          );
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            (olds?.knowledgeBaseConfiguration?.type ?? undefined) !==
            (news?.knowledgeBaseConfiguration?.type ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          // description, role, and tags converge via update.
        }),

        reconcile: Effect.fn(function* ({
          id,
          news = {} as KnowledgeBaseProps,
          output,
          session,
        }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let kb = output?.knowledgeBaseId
            ? yield* getKbOrUndefined(output.knowledgeBaseId)
            : undefined;
          if (kb === undefined) {
            const foundId = yield* findByName(name);
            if (foundId !== undefined) {
              kb = yield* getKbOrUndefined(foundId);
            }
          }

          if (kb === undefined) {
            // 2. ENSURE
            const created = yield* bedrock.createKnowledgeBase({
              name,
              description: news.description,
              roleArn: news.roleArn,
              knowledgeBaseConfiguration: news.knowledgeBaseConfiguration,
              storageConfiguration: news.storageConfiguration,
              tags: desiredTags,
            });
            kb = created.knowledgeBase;
            kb = (yield* waitForSettled(kb.knowledgeBaseId)) ?? kb;
          } else {
            // 3. SYNC — converge mutable settings.
            kb = (yield* waitForSettled(kb.knowledgeBaseId)) ?? kb;
            const drifted =
              kb.description !== news.description ||
              kb.roleArn !== news.roleArn ||
              JSON.stringify(kb.knowledgeBaseConfiguration) !==
                JSON.stringify(news.knowledgeBaseConfiguration) ||
              JSON.stringify(kb.storageConfiguration ?? null) !==
                JSON.stringify(news.storageConfiguration ?? null);
            if (drifted) {
              yield* bedrock.updateKnowledgeBase({
                knowledgeBaseId: kb.knowledgeBaseId,
                name,
                description: news.description,
                roleArn: news.roleArn,
                knowledgeBaseConfiguration: news.knowledgeBaseConfiguration,
                storageConfiguration: news.storageConfiguration,
              });
              kb = (yield* waitForSettled(kb.knowledgeBaseId)) ?? kb;
            }
          }

          const knowledgeBaseId = kb.knowledgeBaseId;
          const knowledgeBaseArn = kb.knowledgeBaseArn;

          // 3b. SYNC TAGS against observed cloud tags.
          const observedTags = yield* fetchObservedTags(knowledgeBaseArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* bedrock.tagResource({
              resourceArn: knowledgeBaseArn,
              tags: Object.fromEntries(
                upsert.map(({ Key, Value }) => [Key, Value]),
              ),
            });
          }
          if (removed.length > 0) {
            yield* bedrock.untagResource({
              resourceArn: knowledgeBaseArn,
              tagKeys: removed,
            });
          }

          yield* session.note(knowledgeBaseArn);
          return {
            knowledgeBaseId,
            knowledgeBaseArn,
            name,
            roleArn: news.roleArn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            bedrock.deleteKnowledgeBase({
              knowledgeBaseId: output.knowledgeBaseId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
