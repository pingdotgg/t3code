import * as textract from "@distilled.cloud/aws/textract";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface AdapterProps {
  /**
   * Name of the adapter — 1-128 characters matching `[a-zA-Z0-9-_]+`. If
   * omitted, a unique name is generated. The name is updatable in place
   * (adapter identity is the server-assigned `adapterId`).
   */
  adapterName?: string;
  /**
   * Description of the adapter, updatable in place. Once set, the Textract
   * API cannot clear it back to empty — removing this prop leaves the last
   * description in place.
   */
  description?: string;
  /**
   * Feature types the adapter enhances. Textract currently supports only
   * `["QUERIES"]`. Changing this replaces the adapter.
   */
  featureTypes: textract.FeatureType[];
  /**
   * Whether Textract automatically retrains the adapter as the base model
   * improves (`ENABLED` or `DISABLED`).
   * @default "DISABLED"
   */
  autoUpdate?: textract.AutoUpdate;
  /**
   * Tags to apply to the adapter. Internal alchemy ownership tags are always
   * added.
   */
  tags?: Record<string, string>;
}

export interface Adapter extends Resource<
  "AWS.Textract.Adapter",
  AdapterProps,
  {
    /**
     * Server-assigned identifier of the adapter (its identity). Pass it in
     * `AdaptersConfig` to `AnalyzeDocument` / `StartDocumentAnalysis`.
     */
    adapterId: string;
    /**
     * ARN of the adapter. Textract uses a nonstandard resource path:
     * `arn:aws:textract:{region}:{account}:/adapters/{adapterId}`.
     */
    adapterArn: string;
    /**
     * Name of the adapter.
     */
    adapterName: string;
    /**
     * Feature types the adapter enhances (currently only `QUERIES`).
     */
    featureTypes: string[];
    /**
     * Whether the adapter auto-updates as the base model improves.
     */
    autoUpdate: string | undefined;
    /**
     * Creation time of the adapter as an ISO-8601 string.
     */
    creationTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Textract adapter — a container for custom, trained adapter
 * versions that enhance the pre-trained Queries feature for your specific
 * documents. The adapter itself is cheap metadata (name, feature types,
 * auto-update, tags); versions are trained separately with
 * `CreateAdapterVersion` against an annotated dataset.
 *
 * @resource
 * @section Managing Adapters
 * @example Create an adapter for the Queries feature
 * ```typescript
 * const adapter = yield* AWS.Textract.Adapter("InvoiceAdapter", {
 *   featureTypes: ["QUERIES"],
 *   description: "Tuned for invoice layouts",
 *   autoUpdate: "ENABLED",
 * });
 * ```
 *
 * @example Analyze a document with a trained adapter version
 * ```typescript
 * const analyzeDocument = yield* AWS.Textract.AnalyzeDocument();
 * const result = yield* analyzeDocument({
 *   Document: { S3Object: { Bucket: bucketName, Name: "invoice.pdf" } },
 *   FeatureTypes: ["QUERIES"],
 *   QueriesConfig: { Queries: [{ Text: "What is the invoice total?" }] },
 *   AdaptersConfig: {
 *     Adapters: [{ AdapterId: adapter.adapterId, Version: "1" }],
 *   },
 * });
 * ```
 */
export const Adapter = Resource<Adapter>("AWS.Textract.Adapter");

const toAttributes = (
  arn: string,
  adapter: textract.GetAdapterResponse & { AdapterId: string },
) => ({
  adapterId: adapter.AdapterId,
  adapterArn: arn,
  adapterName: adapter.AdapterName ?? "",
  featureTypes: [...(adapter.FeatureTypes ?? [])],
  autoUpdate: adapter.AutoUpdate,
  creationTime: adapter.CreationTime?.toISOString(),
});

// Textract's adapter management APIs have very low default rates (~1 TPS);
// bounded backoff absorbs the short bursts the engine's read/diff/reconcile
// sequence emits.
const throttleRetry = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e): boolean =>
        e._tag === "ProvisionedThroughputExceededException" ||
        e._tag === "ThrottlingException",
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  );

const normalizeTags = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const AdapterProvider = () =>
  Provider.effect(
    Adapter,
    Effect.gen(function* () {
      // Adapter names must match [a-zA-Z0-9-_]{1,128}; the engine-generated
      // physical name (alphanumerics + dashes) already satisfies it.
      const toName = (id: string, props: AdapterProps) =>
        props.adapterName
          ? Effect.succeed(props.adapterName)
          : createPhysicalName({ id, maxLength: 128 });

      // Confirmed live: Textract adapter ARNs use a nonstandard resource
      // path with a leading slash — `:/adapters/{adapterId}`.
      const adapterArn = (adapterId: string) =>
        Effect.gen(function* () {
          const { accountId, region } = yield* AWSEnvironment.current;
          return `arn:aws:textract:${region}:${accountId}:/adapters/${adapterId}`;
        });

      const getOne = (adapterId: string) =>
        throttleRetry(textract.getAdapter({ AdapterId: adapterId })).pipe(
          Effect.map((adapter) => ({ ...adapter, AdapterId: adapterId })),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      // Adapter ids are server-assigned, so recovery without persisted
      // output falls back to a bounded name scan.
      const findByName = (name: string) =>
        Effect.gen(function* () {
          let nextToken: string | undefined;
          for (let page = 0; page < 25; page++) {
            const res = yield* throttleRetry(
              textract.listAdapters({ NextToken: nextToken }),
            );
            const match = (res.Adapters ?? []).find(
              (a) => a.AdapterName === name,
            );
            if (match?.AdapterId) return match.AdapterId;
            nextToken = res.NextToken;
            if (!nextToken) break;
          }
          return undefined;
        });

      return {
        stables: ["adapterId", "adapterArn", "creationTime"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          const oldFeatures = [...(olds?.featureTypes ?? [])].sort();
          const newFeatures = [...news.featureTypes].sort();
          if (
            oldFeatures.length !== newFeatures.length ||
            oldFeatures.some((f, i) => f !== newFeatures[i])
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const adapterId =
            output?.adapterId ??
            (yield* findByName(
              yield* toName(id, olds ?? { featureTypes: [] }),
            ));
          if (!adapterId) return undefined;
          const found = yield* getOne(adapterId);
          if (!found) return undefined;
          return toAttributes(yield* adapterArn(adapterId), found);
        }),
        list: () =>
          Effect.gen(function* () {
            const attrs: ReturnType<typeof toAttributes>[] = [];
            let nextToken: string | undefined;
            for (let page = 0; page < 25; page++) {
              const res = yield* throttleRetry(
                textract.listAdapters({ NextToken: nextToken }),
              );
              for (const overview of res.Adapters ?? []) {
                if (overview.AdapterId) {
                  const found = yield* getOne(overview.AdapterId);
                  if (found) {
                    attrs.push(
                      toAttributes(
                        yield* adapterArn(overview.AdapterId),
                        found,
                      ),
                    );
                  }
                }
              }
              nextToken = res.NextToken;
              if (!nextToken) break;
            }
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Observe — cloud state is authoritative; `output` is only a
          // cached id hint and may be stale.
          let adapterId = output?.adapterId ?? (yield* findByName(name));
          let observed = adapterId ? yield* getOne(adapterId) : undefined;

          // Ensure — create when missing; a ConflictException means another
          // writer won the race, so fall through to the name lookup.
          if (!observed) {
            const created = yield* throttleRetry(
              textract.createAdapter({
                AdapterName: name,
                FeatureTypes: news.featureTypes,
                Description: news.description,
                AutoUpdate: news.autoUpdate,
                Tags: desiredTags,
              }),
            ).pipe(
              Effect.catchTag("ConflictException", () =>
                Effect.succeed(undefined),
              ),
            );
            adapterId = created?.AdapterId ?? (yield* findByName(name));
            if (!adapterId) {
              return yield* Effect.die(
                new Error(
                  `Textract adapter ${name} was neither created nor found`,
                ),
              );
            }
            observed = yield* getOne(adapterId);
          }

          yield* session.note(adapterId!);
          const arn = yield* adapterArn(adapterId!);

          // Sync mutable settings — diff observed against desired and apply
          // only the delta. UpdateAdapter treats omitted fields as unchanged.
          const update: textract.UpdateAdapterRequest = {
            AdapterId: adapterId!,
          };
          let dirty = false;
          if (observed?.AdapterName !== name) {
            update.AdapterName = name;
            dirty = true;
          }
          if (
            news.description !== undefined &&
            observed?.Description !== news.description
          ) {
            update.Description = news.description;
            dirty = true;
          }
          if (
            news.autoUpdate !== undefined &&
            observed?.AutoUpdate !== news.autoUpdate
          ) {
            update.AutoUpdate = news.autoUpdate;
            dirty = true;
          }
          if (dirty) {
            yield* throttleRetry(textract.updateAdapter(update));
          }

          // Sync tags — diff against the OBSERVED cloud tags (adoption may
          // hand us foreign tags), not olds/output.
          const { removed, upsert } = diffTags(
            normalizeTags(observed?.Tags),
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* throttleRetry(
              textract.tagResource({
                ResourceARN: arn,
                Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              }),
            );
          }
          if (removed.length > 0) {
            yield* throttleRetry(
              textract.untagResource({
                ResourceARN: arn,
                TagKeys: removed,
              }),
            );
          }

          const final = yield* getOne(adapterId!);
          return toAttributes(
            arn,
            final ?? { AdapterId: adapterId!, AdapterName: name },
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the adapter may already be gone.
          yield* throttleRetry(
            textract.deleteAdapter({ AdapterId: output.adapterId }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
