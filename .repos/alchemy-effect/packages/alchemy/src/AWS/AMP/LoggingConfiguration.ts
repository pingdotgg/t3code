import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { normalizeAmpLogGroupArn } from "./internal.ts";

export interface LoggingConfigurationProps {
  /**
   * Id of the AMP workspace whose rules/alerting logs are shipped. A
   * workspace has at most one logging configuration. Changing the workspace
   * replaces the configuration.
   */
  workspaceId: string;
  /**
   * ARN of the CloudWatch Logs log group that receives the workspace's rule
   * evaluation and alerting (vended) logs. AMP expects the ARN with a
   * trailing `:*` — one is appended automatically when missing.
   */
  logGroupArn: string;
}

export interface LoggingConfiguration extends Resource<
  "AWS.AMP.LoggingConfiguration",
  LoggingConfigurationProps,
  {
    workspaceId: string;
    logGroupArn: string;
    status: string;
  },
  never,
  Providers
> {}

/**
 * The rules/alerting logging configuration of an Amazon Managed Service for
 * Prometheus workspace — ships rule evaluation failures and Alertmanager
 * delivery errors to a CloudWatch Logs log group. A workspace has at most
 * one.
 *
 * @resource
 * @section Creating a Logging Configuration
 * @example Ship Rule and Alerting Logs to CloudWatch Logs
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {});
 * const logs = yield* Logs.LogGroup("AmpLogs", {
 *   logGroupName: "/aws/vendedlogs/prometheus/metrics",
 * });
 * const logging = yield* AMP.LoggingConfiguration("Logging", {
 *   workspaceId: workspace.workspaceId,
 *   logGroupArn: logs.logGroupArn,
 * });
 * ```
 */
export const LoggingConfiguration = Resource<LoggingConfiguration>(
  "AWS.AMP.LoggingConfiguration",
);

export const LoggingConfigurationProvider = () =>
  Provider.effect(
    LoggingConfiguration,
    Effect.gen(function* () {
      /** Describe the configuration; typed not-found → undefined. */
      const describe = Effect.fn(function* (workspaceId: string) {
        const response = yield* amp
          .describeLoggingConfiguration({ workspaceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.loggingConfiguration;
      });

      /**
       * Bounded wait toward ACTIVE. Returns the last observed metadata —
       * a still-transitioning configuration converges on a later reconcile.
       */
      const waitActive = Effect.fn(function* (workspaceId: string) {
        return yield* amp.describeLoggingConfiguration({ workspaceId }).pipe(
          Effect.map((r) => r.loggingConfiguration),
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(20),
            ]),
            until: (c) => c.status.statusCode === "ACTIVE",
          }),
        );
      });

      const toAttrs = (meta: amp.LoggingConfigurationMetadata) => ({
        workspaceId: meta.workspace,
        logGroupArn: meta.logGroupArn,
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
          // Logging configurations are not taggable — ownership is implied
          // by the owned parent workspace.
          return toAttrs(meta);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const workspaceId = news!.workspaceId;
          const desiredArn = normalizeAmpLogGroupArn(news!.logGroupArn);

          // 1. Observe — the live configuration is authoritative.
          const existing = yield* describe(workspaceId);

          // 2/3. Ensure + sync — create when absent (tolerating a create
          // race), update when the log group drifts.
          if (existing === undefined) {
            yield* amp
              .createLoggingConfiguration({
                workspaceId,
                logGroupArn: desiredArn,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  amp.updateLoggingConfiguration({
                    workspaceId,
                    logGroupArn: desiredArn,
                  }),
                ),
              );
          } else if (existing.logGroupArn !== desiredArn) {
            yield* amp.updateLoggingConfiguration({
              workspaceId,
              logGroupArn: desiredArn,
            });
          }

          const fresh = yield* waitActive(workspaceId);
          yield* session.note(workspaceId);
          return toAttrs(fresh);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp
            .deleteLoggingConfiguration({ workspaceId: output.workspaceId })
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
