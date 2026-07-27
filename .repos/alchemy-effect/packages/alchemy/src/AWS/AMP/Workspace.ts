import * as amp from "@distilled.cloud/aws/amp";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import { syncAmpTags, toTagRecord } from "./internal.ts";

export interface WorkspaceLabelSetLimit {
  /**
   * The label set the limit applies to, as exact label name/value pairs. An
   * empty record (`{}`) is the default bucket — it applies to all time
   * series that match no other label set entry.
   */
  labelSet: Record<string, string>;
  /**
   * Maximum number of active time series that can carry this label set.
   * Omit to track the label set without enforcing a limit.
   */
  maxSeries?: number;
}

export interface WorkspaceProps {
  /**
   * A human-readable alias for the workspace. Aliases are not unique — many
   * workspaces can share one. Updating the alias is an in-place update.
   */
  alias?: string;
  /**
   * ARN of a customer-managed KMS key used to encrypt data at rest. If
   * omitted, an AWS-owned key is used. Changing the key replaces the
   * workspace (encryption configuration is immutable).
   */
  kmsKeyArn?: string;
  /**
   * How long the workspace retains ingested metric data. Accepts any
   * `Duration.Input` (e.g. `"30 days"`, `Duration.days(30)`; a bare number
   * is milliseconds); the wire unit is whole days
   * (`retentionPeriodInDays`). If omitted, the workspace keeps the service
   * default retention (150 days) and any retention configured out-of-band
   * is left untouched.
   */
  retentionPeriod?: Duration.Input;
  /**
   * Per-label-set ingestion limits (maximum active series per label set).
   * If omitted, existing label-set limits are left untouched.
   */
  limitsPerLabelSet?: WorkspaceLabelSetLimit[];
  /**
   * User-defined tags for the workspace.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "AWS.AMP.Workspace",
  WorkspaceProps,
  {
    workspaceId: string;
    workspaceArn: string;
    prometheusEndpoint: string | undefined;
    alias: string | undefined;
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Managed Service for Prometheus (AMP) workspace — a logical,
 * fully-managed Prometheus-compatible metrics store. Metrics are ingested
 * via remote-write and queried through the workspace's Prometheus-compatible
 * endpoint.
 *
 * @resource
 * @section Creating a Workspace
 * @example Basic Workspace
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {
 *   alias: "production-metrics",
 * });
 * ```
 *
 * @example Workspace with Customer-Managed Encryption
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {
 *   alias: "production-metrics",
 *   kmsKeyArn: key.keyArn,
 *   tags: { team: "observability" },
 * });
 * ```
 *
 * @example Workspace with Custom Retention and Series Limits
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {
 *   alias: "production-metrics",
 *   retentionPeriod: "30 days",
 *   limitsPerLabelSet: [
 *     { labelSet: { team: "billing" }, maxSeries: 100_000 },
 *     { labelSet: {}, maxSeries: 1_000_000 }, // default bucket
 *   ],
 * });
 * ```
 *
 * @section Using the Endpoint
 * @example Read the Remote-Write URL
 * ```typescript
 * // prometheusEndpoint ends in a trailing slash; append `api/v1/remote_write`
 * const remoteWrite = `${workspace.prometheusEndpoint}api/v1/remote_write`;
 * ```
 *
 * @section Runtime Bindings
 * @example Write and Query Metrics from a Function
 * ```typescript
 * // inside a Lambda Function's effect (provide the *Http layers):
 * const remoteWrite = yield* AMP.RemoteWrite(workspace);
 * const metrics = yield* AMP.QueryMetrics(workspace);
 *
 * yield* remoteWrite({
 *   timeseries: [{ name: "jobs_done_total", samples: [{ value: 1 }] }],
 * });
 * const result = yield* metrics.query({ query: "jobs_done_total" });
 * ```
 */
export const Workspace = Resource<Workspace>("AWS.AMP.Workspace");

export const WorkspaceProvider = () =>
  Provider.effect(
    Workspace,
    Effect.gen(function* () {
      const toAttrs = (workspace: amp.WorkspaceDescription) => ({
        workspaceId: workspace.workspaceId,
        workspaceArn: workspace.arn,
        prometheusEndpoint: workspace.prometheusEndpoint,
        alias: workspace.alias,
        status: workspace.status.statusCode,
      });

      /** Describe a workspace by id; typed not-found → undefined. */
      const describe = Effect.fn(function* (workspaceId: string) {
        const response = yield* amp
          .describeWorkspace({ workspaceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.workspace;
      });

      /**
       * Find the workspace carrying this resource's alchemy ownership tags.
       * Workspace ids are server-assigned, so when the persisted output is
       * lost (e.g. a run crashed after create but before state persistence)
       * this tag search is the only way to reclaim the existing workspace
       * instead of creating an orphan-producing duplicate.
       */
      const findByInternalTags = Effect.fn(function* (
        internalTags: Record<string, string>,
      ) {
        const pages = yield* amp.listWorkspaces
          .pages({})
          .pipe(Stream.runCollect);
        const summary = Array.from(pages)
          .flatMap((page) => page.workspaces)
          .find(
            (w) =>
              w.status.statusCode !== "DELETING" &&
              Object.entries(internalTags).every(
                ([key, value]) => toTagRecord(w.tags)[key] === value,
              ),
          );
        return summary === undefined
          ? undefined
          : yield* describe(summary.workspaceId);
      });

      /**
       * Canonical form of a label-set-limits list for observed-vs-desired
       * comparison: entries keyed and sorted by their sorted label set.
       */
      const canonicalLimits = (
        limits: {
          labelSet: Record<string, string | undefined>;
          maxSeries: number | undefined;
        }[],
      ) =>
        JSON.stringify(
          limits
            .map((entry) => ({
              labelSet: Object.fromEntries(
                Object.entries(entry.labelSet)
                  .filter(
                    (kv): kv is [string, string] => typeof kv[1] === "string",
                  )
                  .sort(([a], [b]) => a.localeCompare(b)),
              ),
              maxSeries: entry.maxSeries ?? null,
            }))
            .sort((a, b) =>
              JSON.stringify(a.labelSet).localeCompare(
                JSON.stringify(b.labelSet),
              ),
            ),
        );

      /**
       * Sync the workspace configuration (retention period + label-set
       * limits) — diff OBSERVED configuration against desired and apply
       * only the delta. Skipped entirely when neither prop is set, so
       * out-of-band configuration is never clobbered.
       */
      const syncWorkspaceConfiguration = Effect.fn(function* (
        workspaceId: string,
        news: WorkspaceProps,
      ) {
        if (
          news.retentionPeriod === undefined &&
          news.limitsPerLabelSet === undefined
        ) {
          return;
        }
        const observed = (yield* amp.describeWorkspaceConfiguration({
          workspaceId,
        })).workspaceConfiguration;

        const desiredDays = toWireDays(news.retentionPeriod);
        const retentionDrifts =
          desiredDays !== undefined &&
          desiredDays !== observed.retentionPeriodInDays;

        const desiredLimits = news.limitsPerLabelSet?.map((entry) => ({
          labelSet: entry.labelSet,
          limits: { maxSeries: entry.maxSeries },
        }));
        const limitsDrift =
          desiredLimits !== undefined &&
          canonicalLimits(
            desiredLimits.map((l) => ({
              labelSet: l.labelSet,
              maxSeries: l.limits.maxSeries,
            })),
          ) !==
            canonicalLimits(
              (observed.limitsPerLabelSet ?? []).map((l) => ({
                labelSet: l.labelSet,
                maxSeries: l.limits.maxSeries,
              })),
            );

        if (!retentionDrifts && !limitsDrift) return;

        // A previous configuration update may still be applying
        // (`UPDATING` rejects new updates with a conflict) — retry briefly.
        yield* amp
          .updateWorkspaceConfiguration({
            workspaceId,
            retentionPeriodInDays: desiredDays,
            limitsPerLabelSet: desiredLimits,
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([
                Schedule.fixed("6 seconds"),
                Schedule.recurs(15),
              ]),
            }),
          );

        // Bounded best-effort wait for the update to apply (the status
        // returns to ACTIVE once the new configuration is in effect). A
        // slower apply converges on a later reconcile.
        yield* amp.describeWorkspaceConfiguration({ workspaceId }).pipe(
          Effect.map((r) => r.workspaceConfiguration),
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(30),
            ]),
            until: (c): boolean =>
              c.status.statusCode === "ACTIVE" &&
              (desiredDays === undefined ||
                c.retentionPeriodInDays === desiredDays),
          }),
        );
      });

      /**
       * Poll until the workspace leaves CREATING/UPDATING and reaches
       * ACTIVE. Fails fast on a *_FAILED terminal status.
       */
      const waitActive = Effect.fn(function* (workspaceId: string) {
        const workspace = yield* amp.describeWorkspace({ workspaceId }).pipe(
          Effect.map((r) => r.workspace),
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(30),
            ]),
            until: (w) => w.status.statusCode === "ACTIVE",
          }),
        );
        if (workspace.status.statusCode !== "ACTIVE") {
          return yield* Effect.fail(
            new Error(
              `AMP workspace ${workspaceId} did not become ACTIVE (status: ${workspace.status.statusCode})`,
            ),
          );
        }
        return workspace;
      });

      return {
        stables: ["workspaceId", "workspaceArn", "prometheusEndpoint"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // Encryption configuration is immutable — a change replaces.
          if (
            (olds?.kmsKeyArn ?? undefined) !== (news?.kmsKeyArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          // Workspace ids are server-assigned; without an output cache the
          // only recoverable identity is the alchemy ownership tags.
          if (!output?.workspaceId) {
            const internalTags = yield* createInternalTags(id);
            const found = yield* findByInternalTags(internalTags);
            // A tag match is by definition owned by this resource.
            return found === undefined ? undefined : toAttrs(found);
          }
          const workspace = yield* describe(output.workspaceId);
          if (workspace === undefined) return undefined;
          const attrs = toAttrs(workspace);
          const tags = toTagRecord(workspace.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output is an id cache.
          // With no cached id (greenfield OR lost state after a crash), fall
          // back to searching by ownership tags: the id is server-assigned,
          // so tags are the only recoverable identity.
          let workspace =
            output?.workspaceId !== undefined
              ? yield* describe(output.workspaceId)
              : yield* findByInternalTags(internalTags);

          // 2. Ensure — create if missing, then wait for ACTIVE.
          if (workspace === undefined) {
            const created = yield* amp.createWorkspace({
              alias: news.alias,
              kmsKeyArn: news.kmsKeyArn,
              tags: desiredTags,
            });
            workspace = yield* waitActive(created.workspaceId);
          }

          const workspaceId = workspace.workspaceId;

          // 3. Sync alias — in-place update when it drifts.
          if ((news.alias ?? undefined) !== (workspace.alias ?? undefined)) {
            yield* amp.updateWorkspaceAlias({
              workspaceId,
              alias: news.alias,
            });
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAmpTags(workspace.arn, desiredTags);

          // 3c. Sync workspace configuration (retention + label-set limits).
          yield* syncWorkspaceConfiguration(workspaceId, news);

          // 4. Re-read for fresh attributes (alias/status may have changed).
          const fresh = (yield* describe(workspaceId)) ?? workspace;
          yield* session.note(workspaceId);
          return toAttrs(fresh);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp.deleteWorkspace({ workspaceId: output.workspaceId }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A workspace mid-transition rejects deletion; retry briefly.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );
        }),

        list: () =>
          amp.listWorkspaces.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.workspaces),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.workspaceId).pipe(
                    Effect.map((w) => (w ? toAttrs(w) : undefined)),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
