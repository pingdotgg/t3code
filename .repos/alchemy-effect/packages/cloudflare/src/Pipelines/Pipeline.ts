import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
   * Immutable — changing the SQL triggers a replacement. Whitespace-only
   * changes are a no-op. A changed, fully-resolved statement is validated
   * during plan, so invalid SQL fails before anything is replaced.
   */
  sql: string;
}

/**
 * Raised during plan when a pipeline's SQL is rejected by Cloudflare's
 * SQL validator (`InvalidSql`, code 1014). Nothing has been replaced or
 * deleted when this fails.
 */
export class PipelineSqlInvalid extends Data.TaggedError(
  "Cloudflare.Pipelines.PipelineSqlInvalid",
)<{
  message: string;
  sql: string;
}> {}

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

export type Pipeline = Resource<TypeId, PipelineProps, PipelineAttributes, never, Providers>;

/**
 * A Cloudflare SQL Pipeline — the transform of the Pipelines product. A
 * pipeline is a single SQL statement that reads events from a
 * {@link Stream} and writes them to a {@link Sink}, both
 * referenced by name.
 *
 * Also exported as `Cloudflare.Basin.Pipeline`.
 *
 * The SQL is fixed at creation: changing it (or the name) triggers a
 * replacement. Nothing references a pipeline downstream, so replacements
 * are cheap. A changed statement is checked with Cloudflare's SQL
 * validator during plan, so a syntax error fails the plan (with
 * {@link PipelineSqlInvalid}) instead of deleting the running pipeline.
 * References to streams/sinks that do not exist yet are not an error at
 * plan time — they are created in the same deploy.
 *
 * Pipelines is ingest-only: to process data after the sink writes it,
 * subscribe to the sink's bucket with `Cloudflare.R2.BucketEventNotification`.
 * ### Creating a Pipeline
 * **Example:** Stream → Sink passthrough
 * ```typescript
 * const stream = yield* Cloudflare.Basin.Stream("events", {});
 * const sink = yield* Cloudflare.Basin.Sink("events-sink", {
 *   type: "r2",
 *   config: { bucket: bucket.bucketName, credentials },
 * });
 *
 * const pipeline = yield* Cloudflare.Basin.Pipeline("etl", {
 *   sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
 * });
 * ```
 *
 * **Example:** Filtering transform
 * ```typescript
 * const pipeline = yield* Cloudflare.Basin.Pipeline("errors-only", {
 *   sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name} WHERE level = 'error'`,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/pipelines/
 *
 * @resource
 * @product Pipelines
 * @category Storage & Databases
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
      if (oldSql === undefined || canonicalSql(news.sql) === canonicalSql(oldSql)) {
        return oldSql === undefined ? undefined : ({ action: "noop" } as const);
      }
      // The replacement deletes the running pipeline — validate the new
      // statement first so bad SQL fails the plan, not the deploy. Tables
      // created in the same deploy are not visible yet, so a missing table
      // is not a validation failure.
      yield* pipelines.validateSqlPipeline({ accountId, sql: news.sql }).pipe(
        Effect.catchTags({
          TableNotFound: () => Effect.void,
          InvalidSql: (error) =>
            Effect.fail(
              new PipelineSqlInvalid({
                message: `Cloudflare.Pipelines.Pipeline '${id}': invalid SQL — ${error.message}`,
                sql: news.sql,
              }),
            ),
        }),
      );
      return { action: "replace" } as const;
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
      if (
        observed &&
        (canonicalSql(observed.sql) !== canonicalSql(sql) || observed.name !== name)
      ) {
        yield* deletePipeline(accountId, observed.id);
        // Wait until the delete is visible so the recreate below does not
        // race an `PipelineAlreadyExists` against the dying pipeline.
        yield* getPipeline(accountId, observed.id).pipe(
          Effect.repeat({
            schedule: Schedule.max([Schedule.exponential("250 millis"), Schedule.recurs(8)]),
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
        observed = yield* pipelines.createV1Pipeline({ accountId, name, sql }).pipe(
          Effect.retry({
            while: (e) => e._tag === "TableNotFound",
            schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(6)]),
          }),
          Effect.catchTag("PipelineAlreadyExists", (error) =>
            findPipelineByName(accountId, name).pipe(
              Effect.flatMap((match) => (match ? Effect.succeed(match) : Effect.fail(error))),
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
 * Canonical SQL for change detection: whitespace runs outside quoted
 * literals/identifiers collapse to one space, surrounding whitespace and
 * a trailing `;` are dropped.
 */
const canonicalSql = (sql: string): string => {
  let out = "";
  let quote: string | undefined;
  let pendingSpace = false;
  for (const ch of sql.trim().replace(/;\s*$/, "")) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = undefined;
    } else if (/\s/.test(ch)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && out.length > 0) out += " ";
      pendingSpace = false;
      if (ch === "'" || ch === '"' || ch === "`") quote = ch;
      out += ch;
    }
  }
  return out;
};

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
    Effect.catchTag("PipelineNotExists", () => Effect.undefined),
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

const toAttributes = (observed: ObservedPipeline, accountId: string): PipelineAttributes => ({
  pipelineId: observed.id,
  accountId,
  name: observed.name,
  sql: observed.sql,
  status: observed.status,
  createdAt: observed.createdAt,
  modifiedAt: observed.modifiedAt,
});
