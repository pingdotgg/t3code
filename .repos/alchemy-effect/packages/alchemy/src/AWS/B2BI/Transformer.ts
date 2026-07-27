import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readB2biTags, syncB2biTags, toWireTags } from "./internal.ts";

export interface TransformerProps {
  /**
   * The name of the transformer.
   */
  name: string;
  /**
   * The transformer's processing state. Newly created transformers default
   * to `inactive`; set to `active` to make the transformer usable by a
   * capability. Activation is one-way: an active transformer rejects every
   * update (including deactivation), so changing the configuration, name, or
   * status of an active transformer replaces it.
   * @default "inactive"
   */
  status?: "active" | "inactive";
  /**
   * Describes the format of the source document (e.g. X12 EDI) and any
   * advanced options for parsing it.
   */
  inputConversion?: b2bi.InputConversion;
  /**
   * The mapping template (JSONATA or XSLT) that transforms the input
   * document into the output format.
   */
  mapping?: b2bi.Mapping;
  /**
   * Describes the format of the output document (e.g. X12 EDI) for outbound
   * transformers.
   */
  outputConversion?: b2bi.OutputConversion;
  /**
   * Locations of sample input and output documents used to test the
   * transformer.
   */
  sampleDocuments?: b2bi.SampleDocuments;
  /**
   * User-defined tags for the transformer.
   */
  tags?: Record<string, string>;
}

export interface Transformer extends Resource<
  "AWS.B2BI.Transformer",
  TransformerProps,
  {
    /**
     * Service-assigned unique ID of the transformer.
     */
    transformerId: string;
    /**
     * ARN of the transformer.
     */
    transformerArn: string;
    /**
     * Name of the transformer.
     */
    name: string;
    /**
     * Current status (`active` or `inactive`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS B2B Data Interchange (B2BI) transformer. A transformer describes
 * how to convert inbound EDI documents to a target format (or the reverse)
 * using a mapping template. Transformers are credential-free and testable.
 *
 * Activation is one-way: B2BI rejects every update to an `active`
 * transformer, including a status-only deactivation, so changing the
 * configuration, name, or status of an active transformer replaces it
 * (delete-first). Deletion works regardless of status.
 * @resource
 * @section Creating a Transformer
 * @example Inbound X12 to JSON
 * ```typescript
 * const transformer = yield* B2BI.Transformer("X12ToJson", {
 *   name: "x12-to-json",
 *   status: "active",
 *   inputConversion: {
 *     fromFormat: "X12",
 *     formatOptions: { x12: { transactionSet: "X12_850", version: "VERSION_4010" } },
 *   },
 *   mapping: {
 *     templateLanguage: "JSONATA",
 *     template: "{ \"orderId\": transactionSets[0].St.transactionSetControlNumber }",
 *   },
 * });
 * ```
 */
export const Transformer = Resource<Transformer>("AWS.B2BI.Transformer");

const toAttrs = (
  r:
    | b2bi.GetTransformerResponse
    | b2bi.CreateTransformerResponse
    | b2bi.UpdateTransformerResponse,
) => ({
  transformerId: r.transformerId,
  transformerArn: r.transformerArn,
  name: r.name,
  status: r.status,
});

/** JSON fingerprint of the mutable transformer configuration. */
const spec = (
  props: Pick<
    TransformerProps,
    "inputConversion" | "mapping" | "outputConversion" | "sampleDocuments"
  >,
): string =>
  JSON.stringify({
    inputConversion: props.inputConversion ?? null,
    mapping: props.mapping ?? null,
    outputConversion: props.outputConversion ?? null,
    sampleDocuments: props.sampleDocuments ?? null,
  });

export const TransformerProvider = () =>
  Provider.effect(
    Transformer,
    Effect.gen(function* () {
      const findByName = (name: string) =>
        b2bi.listTransformers.items({}).pipe(
          Stream.filter((s) => s.name === name),
          Stream.runHead,
          Effect.flatMap((head) =>
            head._tag === "Some"
              ? b2bi
                  .getTransformer({ transformerId: head.value.transformerId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  )
              : Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["transformerId", "transformerArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // An ACTIVE transformer rejects every update — including a
          // status-only deactivation ("An active Transformer cannot be
          // updated", verified live) — so any change away from a deployed
          // active state forces a replacement. Delete-first: transformer
          // names are how lost state is recovered (findByName), so the old
          // instance must be gone before the new one is created.
          if (olds.status === "active") {
            const changed =
              spec(olds) !== spec(news) ||
              olds.name !== news.name ||
              (news.status ?? "inactive") !== "active";
            if (changed) {
              return { action: "replace", deleteFirst: true } as const;
            }
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = output?.transformerId
            ? yield* b2bi
                .getTransformer({ transformerId: output.transformerId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(olds?.name ?? "");
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readB2biTags(attrs.transformerArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredStatus = news.status ?? "inactive";

          // 1. Observe.
          let live = output?.transformerId
            ? yield* b2bi
                .getTransformer({ transformerId: output.transformerId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(news.name);

          // 2. Ensure.
          if (live === undefined) {
            const created = yield* b2bi.createTransformer({
              name: news.name,
              inputConversion: news.inputConversion,
              mapping: news.mapping,
              outputConversion: news.outputConversion,
              sampleDocuments: news.sampleDocuments,
              tags: toWireTags(desiredTags),
            });
            live = yield* b2bi.getTransformer({
              transformerId: created.transformerId,
            });
          }

          // 3. Sync — converge name/config while the transformer is still
          // inactive, then activate last. An ACTIVE transformer rejects every
          // update (including a status-only deactivation), so drift against
          // an active transformer cannot be converged in place — `diff`
          // reports those changes as a delete-first replacement.
          const configDrift = spec(live) !== spec(news);
          const nameDrift = live.name !== news.name;
          const statusDrift = live.status !== desiredStatus;
          if (live.status === "active" && (configDrift || nameDrift)) {
            return yield* Effect.fail(
              new Error(
                `Transformer '${live.transformerId}' is active and cannot be updated in place — B2BI rejects every update to an active transformer. Replace it instead.`,
              ),
            );
          }
          if (configDrift || nameDrift) {
            // Config update carries NO status field (a status change in the
            // same call as a config change is rejected).
            const updated = yield* b2bi.updateTransformer({
              transformerId: live.transformerId,
              name: news.name,
              inputConversion: news.inputConversion,
              mapping: news.mapping,
              outputConversion: news.outputConversion,
              sampleDocuments: news.sampleDocuments,
            });
            live = { ...live, ...updated };
          }
          if (statusDrift && desiredStatus === "active") {
            const updated = yield* b2bi.updateTransformer({
              transformerId: live.transformerId,
              status: "active",
            });
            live = { ...live, ...updated };
          }

          // 3b. Sync tags.
          yield* syncB2biTags(live.transformerArn, desiredTags);

          yield* session.note(live.transformerId);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteTransformer works on both active and inactive transformers
          // (verified live) — no deactivation step is needed (nor possible:
          // an active transformer rejects all updates).
          yield* b2bi
            .deleteTransformer({ transformerId: output.transformerId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          // NOTE: transformer creation auto-creates the shared account-level
          // /aws/vendedlogs/b2bi/transformers log group. That group is a
          // service-managed singleton (like a service-linked role) and MUST
          // NOT be reaped here: B2BI's internal log-delivery bookkeeping
          // references it, and deleting it opens a ~60-90s window where every
          // subsequent createTransformer in the account fails with
          // "Unable to perform CreateLogDelivery. Log destination resource
          // /aws/vendedlogs/b2bi/transformers was not found" (verified live).
        }),

        list: () =>
          b2bi.listTransformers.items({}).pipe(
            Stream.mapEffect((s) =>
              b2bi.getTransformer({ transformerId: s.transformerId }).pipe(
                Effect.map(toAttrs),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              ),
            ),
            Stream.filter((item) => item !== undefined),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
