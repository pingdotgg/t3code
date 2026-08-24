import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { normalizeAmpLogGroupArn } from "./internal.ts";

export interface QueryLoggingDestination {
  /**
   * ARN of the CloudWatch Logs log group that receives query logs. AMP
   * expects the ARN with a trailing `:*` — one is appended automatically
   * when missing.
   */
  logGroupArn: string;
  /**
   * Only queries that spend at least this many Query Samples Processed
   * (QSP) are logged. Use `0` to log every query.
   * @default 0
   */
  qspThreshold?: number;
}

export interface QueryLoggingConfigurationProps {
  /**
   * Id of the AMP workspace whose queries are logged. A workspace has at
   * most one query logging configuration. Changing the workspace replaces
   * the configuration.
   */
  workspaceId: string;
  /**
   * Destinations that receive the query logs (currently CloudWatch Logs
   * log groups, each with a QSP filter threshold). Updated in place.
   */
  destinations: QueryLoggingDestination[];
}

export interface QueryLoggingConfiguration extends Resource<
  "AWS.AMP.QueryLoggingConfiguration",
  QueryLoggingConfigurationProps,
  {
    workspaceId: string;
    destinations: { logGroupArn: string; qspThreshold: number }[];
    status: string;
  },
  never,
  Providers
> {}

/**
 * The query logging configuration of an Amazon Managed Service for
 * Prometheus workspace — ships PromQL query logs (query text, QSP cost,
 * response code) to CloudWatch Logs. A workspace has at most one.
 *
 * @resource
 * @section Creating a Query Logging Configuration
 * @example Log Expensive Queries to CloudWatch Logs
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {});
 * const logs = yield* Logs.LogGroup("QueryLogs", {
 *   logGroupName: "/aws/vendedlogs/prometheus/metrics-queries",
 * });
 * const queryLogging = yield* AMP.QueryLoggingConfiguration("QueryLogging", {
 *   workspaceId: workspace.workspaceId,
 *   destinations: [{ logGroupArn: logs.logGroupArn, qspThreshold: 1000 }],
 * });
 * ```
 */
export const QueryLoggingConfiguration = Resource<QueryLoggingConfiguration>(
  "AWS.AMP.QueryLoggingConfiguration",
);

export const QueryLoggingConfigurationProvider = () =>
  Provider.effect(
    QueryLoggingConfiguration,
    Effect.gen(function* () {
      /** Describe the configuration; typed not-found → undefined. */
      const describe = Effect.fn(function* (workspaceId: string) {
        const response = yield* amp
          .describeQueryLoggingConfiguration({ workspaceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.queryLoggingConfiguration;
      });

      /**
       * Bounded wait toward ACTIVE. Returns the last observed metadata —
       * a still-transitioning configuration converges on a later reconcile.
       */
      const waitActive = Effect.fn(function* (workspaceId: string) {
        return yield* amp
          .describeQueryLoggingConfiguration({ workspaceId })
          .pipe(
            Effect.map((r) => r.queryLoggingConfiguration),
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(20),
              ]),
              until: (c) => c.status.statusCode === "ACTIVE",
            }),
          );
      });

      /** Desired props → wire destinations (normalized + defaulted). */
      const toWireDestinations = (destinations: QueryLoggingDestination[]) =>
        destinations.map((destination) => ({
          cloudWatchLogs: {
            logGroupArn: normalizeAmpLogGroupArn(destination.logGroupArn),
          },
          filters: { qspThreshold: destination.qspThreshold ?? 0 },
        }));

      /** Canonical form for observed-vs-desired comparison. */
      const canonical = (
        destinations: {
          cloudWatchLogs: { logGroupArn: string };
          filters: { qspThreshold: number };
        }[],
      ) =>
        JSON.stringify(
          destinations
            .map((d) => ({
              logGroupArn: d.cloudWatchLogs.logGroupArn,
              qspThreshold: d.filters.qspThreshold,
            }))
            .sort((a, b) => a.logGroupArn.localeCompare(b.logGroupArn)),
        );

      const toAttrs = (meta: amp.QueryLoggingConfigurationMetadata) => ({
        workspaceId: meta.workspace,
        destinations: meta.destinations.map((d) => ({
          logGroupArn: d.cloudWatchLogs.logGroupArn,
          qspThreshold: d.filters.qspThreshold,
        })),
        status: meta.status.statusCode,
      });

      return {
        stables: ["workspaceId"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds?.workspaceId !== news.workspaceId) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const workspaceId = output?.workspaceId ?? olds?.workspaceId;
          if (!workspaceId) return undefined;
          const meta = yield* describe(workspaceId);
          if (meta === undefined) return undefined;
          // Query logging configurations are not taggable — ownership is
          // implied by the owned parent workspace.
          return toAttrs(meta);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const workspaceId = news!.workspaceId;
          const desired = toWireDestinations(news!.destinations);

          // 1. Observe — the live configuration is authoritative.
          const existing = yield* describe(workspaceId);

          // 2/3. Ensure + sync — create when absent (tolerating a create
          // race), update when the destinations drift.
          if (existing === undefined) {
            yield* amp
              .createQueryLoggingConfiguration({
                workspaceId,
                destinations: desired,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  amp.updateQueryLoggingConfiguration({
                    workspaceId,
                    destinations: desired,
                  }),
                ),
              );
          } else if (
            canonical([...existing.destinations]) !== canonical(desired)
          ) {
            yield* amp.updateQueryLoggingConfiguration({
              workspaceId,
              destinations: desired,
            });
          }

          const fresh = yield* waitActive(workspaceId);
          yield* session.note(workspaceId);
          return toAttrs(fresh);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp
            .deleteQueryLoggingConfiguration({
              workspaceId: output.workspaceId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(20),
                ]),
              }),
            );
        }),

        // Singleton sub-resource keyed by its parent workspace.
        list: () => Effect.succeed([]),
      };
    }),
  );
