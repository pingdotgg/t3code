import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
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

export type RetrieverStatus = qbusiness.RetrieverStatus;
export type RetrieverType = qbusiness.RetrieverType;

export interface RetrieverProps {
  /**
   * The identifier of the Amazon Q Business application the retriever
   * attaches to. Changing it replaces the retriever.
   */
  applicationId: string;
  /**
   * The retriever type — `NATIVE_INDEX` (an Amazon Q Business index) or
   * `KENDRA_INDEX` (an existing Amazon Kendra index). Changing it replaces
   * the retriever.
   */
  type: RetrieverType;
  /**
   * Display name of the retriever.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * The index the retriever queries — `nativeIndexConfiguration` for a
   * `NATIVE_INDEX` retriever, `kendraIndexConfiguration` for a
   * `KENDRA_INDEX` retriever.
   */
  configuration: qbusiness.RetrieverConfiguration;
  /**
   * ARN of the IAM role the retriever assumes (required for
   * `KENDRA_INDEX` retrievers to query the Kendra index).
   */
  roleArn?: string;
  /**
   * Tags to associate with the retriever.
   */
  tags?: Record<string, string>;
}

export interface Retriever extends Resource<
  "AWS.QBusiness.Retriever",
  RetrieverProps,
  {
    /**
     * Service-assigned unique identifier of the retriever (unique within
     * its application).
     */
    retrieverId: string;
    /**
     * The identifier of the application the retriever belongs to.
     */
    applicationId: string;
    /**
     * ARN of the retriever.
     */
    retrieverArn: string;
    /**
     * The retriever's display name.
     */
    displayName: string;
    /**
     * The retriever type.
     */
    type: RetrieverType | undefined;
    /**
     * Current lifecycle status of the retriever.
     */
    status: RetrieverStatus | undefined;
    /**
     * Current tags reported for the retriever.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Q Business retriever — the query engine that fetches relevant
 * passages from an index (native or Kendra) to ground chat responses.
 *
 * @resource
 * @section Creating Retrievers
 * @example Native Index Retriever
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const retriever = yield* AWS.QBusiness.Retriever("Docs", {
 *   applicationId: app.applicationId,
 *   type: "NATIVE_INDEX",
 *   configuration: {
 *     nativeIndexConfiguration: { indexId: index.indexId },
 *   },
 * });
 * ```
 *
 * @example Kendra Index Retriever
 * ```typescript
 * const retriever = yield* AWS.QBusiness.Retriever("Kendra", {
 *   applicationId: app.applicationId,
 *   type: "KENDRA_INDEX",
 *   roleArn: role.roleArn,
 *   configuration: {
 *     kendraIndexConfiguration: { indexId: kendraIndex.id },
 *   },
 * });
 * ```
 */
export const Retriever = Resource<Retriever>("AWS.QBusiness.Retriever");

const createDisplayName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

const fetchTags = Effect.fn(function* (arn: string) {
  const response = yield* qbusiness
    .listTagsForResource({ resourceARN: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    (response?.tags ?? []).map((tag) => [tag.key, tag.value]),
  );
});

interface RetrieverState {
  attrs: Retriever["Attributes"];
  described: qbusiness.GetRetrieverResponse;
}

const readRetrieverById = Effect.fn(function* (
  applicationId: string,
  retrieverId: string,
) {
  const described = yield* qbusiness
    .getRetriever({ applicationId, retrieverId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described) return undefined;
  const arn = described.retrieverArn;
  if (arn === undefined) return undefined;
  const state: RetrieverState = {
    described,
    attrs: {
      retrieverId: described.retrieverId ?? retrieverId,
      applicationId: described.applicationId ?? applicationId,
      retrieverArn: arn,
      displayName: described.displayName ?? "",
      type: described.type,
      status: described.status,
      tags: yield* fetchTags(arn),
    },
  };
  return state;
});

const findRetrieverByName = Effect.fn(function* (
  applicationId: string,
  displayName: string,
) {
  const summaries = yield* qbusiness.listRetrievers
    .pages({ applicationId })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.retrievers ?? []),
      ),
      // The parent application may itself be gone.
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as qbusiness.Retriever[]),
      ),
    );
  const match = summaries.find(
    (summary) => summary.displayName === displayName,
  );
  if (!match?.retrieverId) return undefined;
  return yield* readRetrieverById(applicationId, match.retrieverId);
});

/**
 * A retriever still transitioning toward `ACTIVE` — retried by
 * {@link waitForRetrieverActive}'s bounded schedule.
 */
class RetrieverNotReady extends Data.TaggedError("RetrieverNotReady")<{
  readonly retrieverId: string;
  readonly status: string | undefined;
}> {}

/**
 * A retriever whose asynchronous provisioning converged to the terminal
 * `FAILED` status.
 */
export class RetrieverProvisioningFailed extends Data.TaggedError(
  "RetrieverProvisioningFailed",
)<{
  readonly retrieverId: string;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "RetrieverNotReady",
    // Retriever provisioning is fast; poll every 5s up to ~5 min.
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
  });

const waitForRetrieverActive = (applicationId: string, retrieverId: string) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* qbusiness
        .getRetriever({ applicationId, retrieverId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (described?.status === "ACTIVE") return;
      if (described?.status === "FAILED") {
        return yield* Effect.fail(
          new RetrieverProvisioningFailed({ retrieverId }),
        );
      }
      return yield* Effect.fail(
        new RetrieverNotReady({ retrieverId, status: described?.status }),
      );
    }),
  );

export const RetrieverProvider = () =>
  Provider.effect(
    Retriever,
    Effect.gen(function* () {
      return {
        stables: ["retrieverId", "applicationId", "retrieverArn"],
        // Keyed by a parent application; cannot be enumerated account-wide
        // without iterating every application — treated as a sub-resource per
        // the factory list() convention.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const applicationId = output?.applicationId ?? olds?.applicationId;
          if (applicationId === undefined) return undefined;
          const state = output?.retrieverId
            ? yield* readRetrieverById(applicationId, output.retrieverId)
            : yield* findRetrieverByName(
                applicationId,
                yield* createDisplayName(id, olds ?? {}),
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The parent application and retriever type are fixed at creation.
          if (
            olds.applicationId !== news.applicationId ||
            olds.type !== news.type
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("QBusiness Retriever requires props"),
            );
          }
          const applicationId = news.applicationId;
          const displayName = yield* createDisplayName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let state = output?.retrieverId
            ? yield* readRetrieverById(applicationId, output.retrieverId)
            : yield* findRetrieverByName(applicationId, displayName);

          // Ensure — create if missing, then wait for ACTIVE.
          if (state === undefined) {
            const created = yield* qbusiness.createRetriever({
              applicationId,
              type: news.type,
              displayName,
              configuration: news.configuration,
              roleArn: news.roleArn,
              tags: Object.entries(desiredTags).map(([key, value]) => ({
                key,
                value,
              })),
            });
            if (!created.retrieverId) {
              return yield* Effect.fail(
                new Error(
                  `CreateRetriever for '${displayName}' returned no retrieverId`,
                ),
              );
            }
            yield* session.note(
              `Creating retriever ${displayName} (${created.retrieverId})...`,
            );
            yield* waitForRetrieverActive(applicationId, created.retrieverId);
            state = yield* readRetrieverById(
              applicationId,
              created.retrieverId,
            );
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created retriever ${displayName}`),
              );
            }
          }

          // Sync mutable settings via UpdateRetriever — only when drifted.
          const described = state.described;
          const desiredNativeIndexId =
            news.configuration.nativeIndexConfiguration?.indexId;
          const observedNativeIndexId =
            described.configuration?.nativeIndexConfiguration?.indexId;
          const desiredKendraIndexId =
            news.configuration.kendraIndexConfiguration?.indexId;
          const observedKendraIndexId =
            described.configuration?.kendraIndexConfiguration?.indexId;
          const needsUpdate =
            displayName !== described.displayName ||
            (news.roleArn !== undefined &&
              news.roleArn !== described.roleArn) ||
            desiredNativeIndexId !== observedNativeIndexId ||
            desiredKendraIndexId !== observedKendraIndexId;
          if (needsUpdate) {
            yield* qbusiness.updateRetriever({
              applicationId,
              retrieverId: state.attrs.retrieverId,
              displayName,
              configuration: news.configuration,
              roleArn: news.roleArn,
            });
            yield* waitForRetrieverActive(
              applicationId,
              state.attrs.retrieverId,
            );
            yield* session.note(`Updated retriever ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* qbusiness.untagResource({
              resourceARN: state.attrs.retrieverArn,
              tagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* qbusiness.tagResource({
              resourceARN: state.attrs.retrieverArn,
              tags: upsert.map(({ Key, Value }) => ({
                key: Key,
                value: Value,
              })),
            });
          }

          yield* session.note(state.attrs.retrieverArn);

          const final = yield* readRetrieverById(
            applicationId,
            state.attrs.retrieverId,
          );
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled retriever ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* qbusiness
            .deleteRetriever({
              applicationId: output.applicationId,
              retrieverId: output.retrieverId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
