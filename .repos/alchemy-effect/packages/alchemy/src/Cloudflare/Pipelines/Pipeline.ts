import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Pipelines.Pipeline" as const;
type TypeId = typeof TypeId;

export interface PipelineProps {
  /**
   * Name of the pipeline. Unique per account; must be alphanumeric and
   * underscores only. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   *
   * Pipelines have no update API, so changing this (or the `sql`)
   * triggers a replacement.
   * @default ${app}_${id}_${stage}_${suffix}
   */
  name?: string;
  /**
   * SQL statement describing the processing flow, e.g.
   * `INSERT INTO my_sink SELECT * FROM my_stream`. Streams and sinks are
   * referenced by name — interpolate `stream.name` / `sink.name` outputs
   * so the engine orders the pipeline after them on deploy (and before
   * them on destroy).
   *
   * Immutable — changing the SQL triggers a replacement.
   */
  sql: string;
}

export interface PipelineAttributes {
  /** Cloudflare-assigned pipeline identifier. */
  pipelineId: string;
  /** Account that owns the pipeline. */
  accountId: string;
  /** Pipeline name (unique per account). */
  name: string;
  /** SQL statement of the processing flow. */
  sql: string;
  /** Current status of the pipeline. */
  status: string;
  /** When the pipeline was created. */
  createdAt: string;
  /** When the pipeline was last modified. */
  modifiedAt: string;
}

export type Pipeline = Resource<
  TypeId,
  PipelineProps,
  PipelineAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare SQL Pipeline — the transform of the Pipelines product. A
 * pipeline is a single SQL statement that reads events from a
 * {@link Stream} and writes them to a {@link Sink}, both
 * referenced by name.
 *
 * The SQL is fixed at creation: changing it (or the name) triggers a
 * replacement. Nothing references a pipeline downstream, so replacements
 * are cheap.
 * @resource
 * @product Pipelines
 * @category Storage & Databases
 * @section Creating a Pipeline
 * @example Stream → Sink passthrough
 * ```typescript
 * const stream = yield* Cloudflare.Pipelines.Stream("events", {});
 * const sink = yield* Cloudflare.Pipelines.Sink("events-sink", {
 *   type: "r2",
 *   config: { bucket: bucket.bucketName, credentials },
 * });
 *
 * const pipeline = yield* Cloudflare.Pipelines.Pipeline("etl", {
 *   sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
 * });
 * ```
 *
 * @example Filtering transform
 * ```typescript
 * const pipeline = yield* Cloudflare.Pipelines.Pipeline("errors-only", {
 *   sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name} WHERE level = 'error'`,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/pipelines/
 */
export const Pipeline = Resource<Pipeline>(TypeId);

/**
 * Returns true if the given value is a Pipeline resource.
 */
export const isPipeline = (value: unknown): value is Pipeline =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const PipelineProvider = () =>
  Provider.succeed(Pipeline, {
    stables: ["pipelineId", "accountId", "name", "createdAt"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const o = olds as PipelineProps | undefined;
      if (o === undefined) return undefined;
      // Pipelines have no update API — name and sql changes replace.
      const newName = yield* pipelineName(id, news.name);
      const oldName = output?.name ?? (yield* pipelineName(id, o.name));
      if (newName !== oldName) {
        return { action: "replace" } as const;
      }
      const oldSql = typeof o.sql === "string" ? o.sql : output?.sql;
      if (oldSql !== undefined && news.sql !== oldSql) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.pipelineId) {
        const observed = yield* getPipeline(acct, output.pipelineId);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read — pipeline names are unique per account; a
      // generated-name match is proof of ownership, an explicit name is
      // not.
      const name = yield* pipelineName(id, olds?.name);
      const match = yield* findPipelineByName(acct, name);
      if (match) {
        const attrs = toAttributes(match, acct);
        return olds?.name !== undefined ? Unowned(attrs) : attrs;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* pipelineName(id, news.name);
      const sql = news.sql as string;

      // 1. Observe — by cached id first, then by (unique) name so we
      //    recover from lost state writes.
      let observed = output?.pipelineId
        ? yield* getPipeline(output.accountId ?? accountId, output.pipelineId)
        : undefined;
      if (!observed) {
        observed = yield* findPipelineByName(accountId, name);
      }

      // Converge drift — there is no update API, so when the observed SQL
      // differs from the desired SQL (e.g. a referenced stream/sink was
      // replaced and `sql` was unresolved at diff time), delete the stale
      // pipeline and fall through to recreate it under the same name.
      // Nothing references a pipeline downstream, so this is safe.
      if (observed && (observed.sql !== sql || observed.name !== name)) {
        yield* deletePipeline(accountId, observed.id);
        // Wait until the delete is visible so the recreate below does not
        // race an `PipelineAlreadyExists` against the dying pipeline.
        yield* getPipeline(accountId, observed.id).pipe(
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.exponential("250 millis"),
              Schedule.recurs(8),
            ]),
            until: (p) => p === undefined,
          }),
        );
        observed = undefined;
      }

      // 2. Ensure — create when missing. The referenced stream/sink may
      //    have been created moments ago, so ride out eventual-consistency
      //    `TableNotFound` blips with a bounded retry. An AlreadyExists is
      //    a race or recovery — resolve it via the name lookup. There is
      //    no sync step: the SQL is immutable, so changes arrive as
      //    replacements (diff).
      if (!observed) {
        observed = yield* pipelines
          .createV1Pipeline({ accountId, name, sql })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "TableNotFound",
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(6),
              ]),
            }),
            Effect.catchTag("PipelineAlreadyExists", (error) =>
              findPipelineByName(accountId, name).pipe(
                Effect.flatMap((match) =>
                  match ? Effect.succeed(match) : Effect.fail(error),
                ),
              ),
            ),
          );
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deletePipeline(output.accountId, output.pipelineId);
    }),

    // Account collection — pipelines are account-scoped. Exhaustively
    // paginate the account-wide list and hydrate each row into the same
    // Attributes shape `read` returns.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* pipelines.listV1Pipeline.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((p) => toAttributes(p, accountId)),
          ),
        ),
      );
    }),
  });

/**
 * The subset of pipeline state shared by get/list/create responses.
 */
interface ObservedPipeline {
  id: string;
  name: string;
  sql: string;
  status: string;
  createdAt: string;
  modifiedAt: string;
}

// Pipelines entity names must be alphanumeric/underscore only, so swap
// the default hyphen delimiter for underscores.
const pipelineName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    const generated = yield* createPhysicalName({
      id,
      lowercase: true,
      delimiter: "_",
    });
    return generated.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  });

/**
 * Read a pipeline by id, mapping "gone" (`PipelineNotExists`, Cloudflare
 * error code 1000) to `undefined`.
 */
const getPipeline = (accountId: string, pipelineId: string) =>
  pipelines.getV1Pipeline({ accountId, pipelineId }).pipe(
    Effect.map((p): ObservedPipeline | undefined => p),
    Effect.catchTag("PipelineNotExists", () => Effect.succeed(undefined)),
  );

/**
 * Idempotent delete — a pipeline that is already gone is success.
 */
const deletePipeline = (accountId: string, pipelineId: string) =>
  pipelines
    .deleteV1Pipeline({ accountId, pipelineId })
    .pipe(Effect.catchTag("PipelineNotExists", () => Effect.void));

const findPipelineByName = (accountId: string, name: string) =>
  pipelines.listV1Pipeline.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk): ObservedPipeline | undefined =>
      Array.from(chunk).find((p) => p.name === name),
    ),
  );

const toAttributes = (
  observed: ObservedPipeline,
  accountId: string,
): PipelineAttributes => ({
  pipelineId: observed.id,
  accountId,
  name: observed.name,
  sql: observed.sql,
  status: observed.status,
  createdAt: observed.createdAt,
  modifiedAt: observed.modifiedAt,
});
