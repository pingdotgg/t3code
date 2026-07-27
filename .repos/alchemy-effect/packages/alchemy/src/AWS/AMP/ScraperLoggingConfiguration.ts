import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { normalizeAmpLogGroupArn } from "./internal.ts";

export interface ScraperComponentConfig {
  /**
   * The scraper component the logging applies to (e.g. `"SERVICE_DISCOVERY"`,
   * `"COLLECTOR"`, `"EXPORTER"`).
   */
  type: string;
  /**
   * Component-specific options (e.g. `{ loggingLevel: "DEBUG" }`).
   */
  options?: Record<string, string>;
}

export interface ScraperLoggingConfigurationProps {
  /**
   * Id of the AMP scraper whose component logs are shipped. A scraper has
   * at most one logging configuration. Changing the scraper replaces the
   * configuration.
   */
  scraperId: string;
  /**
   * ARN of the CloudWatch Logs log group that receives the scraper's
   * component logs. AMP expects the ARN with a trailing `:*` — one is
   * appended automatically when missing.
   */
  logGroupArn: string;
  /**
   * Per-component logging configuration. If omitted, the service default
   * component set is logged.
   */
  components?: ScraperComponentConfig[];
}

export interface ScraperLoggingConfiguration extends Resource<
  "AWS.AMP.ScraperLoggingConfiguration",
  ScraperLoggingConfigurationProps,
  {
    scraperId: string;
    logGroupArn: string;
    status: string;
  },
  never,
  Providers
> {}

/**
 * The logging configuration of an Amazon Managed Service for Prometheus
 * scraper — ships the scraper's component logs (service discovery,
 * collection, export) to a CloudWatch Logs log group. A scraper has at most
 * one.
 *
 * @resource
 * @section Creating a Scraper Logging Configuration
 * @example Ship Scraper Logs to CloudWatch Logs
 * ```typescript
 * const logs = yield* Logs.LogGroup("ScraperLogs", {
 *   logGroupName: "/aws/vendedlogs/prometheus/scraper",
 * });
 * const logging = yield* AMP.ScraperLoggingConfiguration("ScraperLogging", {
 *   scraperId: scraper.scraperId,
 *   logGroupArn: logs.logGroupArn,
 * });
 * ```
 */
export const ScraperLoggingConfiguration =
  Resource<ScraperLoggingConfiguration>("AWS.AMP.ScraperLoggingConfiguration");

export const ScraperLoggingConfigurationProvider = () =>
  Provider.effect(
    ScraperLoggingConfiguration,
    Effect.gen(function* () {
      /** Describe the configuration; typed not-found → undefined. */
      const describe = Effect.fn(function* (scraperId: string) {
        return yield* amp
          .describeScraperLoggingConfiguration({ scraperId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttrs = (
        config: amp.DescribeScraperLoggingConfigurationResponse,
      ) => ({
        scraperId: config.scraperId,
        logGroupArn: config.loggingDestination.cloudWatchLogs.logGroupArn,
        status: config.status.statusCode,
      });

      /** Canonical component list for observed-vs-desired comparison. */
      const canonicalComponents = (
        components: {
          type: string;
          config?: { options?: Record<string, string | undefined> };
        }[],
      ) =>
        JSON.stringify(
          components
            .map((component) => ({
              type: component.type,
              options: Object.fromEntries(
                Object.entries(component.config?.options ?? {})
                  .filter(
                    (kv): kv is [string, string] => typeof kv[1] === "string",
                  )
                  .sort(([a], [b]) => a.localeCompare(b)),
              ),
            }))
            .sort((a, b) => a.type.localeCompare(b.type)),
        );

      const toWireComponents = (
        components: ScraperComponentConfig[] | undefined,
      ): amp.ScraperComponent[] | undefined =>
        components?.map((component) => ({
          type: component.type,
          config:
            component.options !== undefined
              ? { options: component.options }
              : undefined,
        }));

      return {
        stables: ["scraperId"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds?.scraperId !== news.scraperId) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const scraperId = output?.scraperId ?? olds?.scraperId;
          if (!scraperId) return undefined;
          const config = yield* describe(scraperId);
          if (config === undefined) return undefined;
          // Scraper logging configurations are not taggable — ownership is
          // implied by the owned parent scraper.
          return toAttrs(config);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const scraperId = news!.scraperId;
          const desiredArn = normalizeAmpLogGroupArn(news!.logGroupArn);
          const desiredComponents = toWireComponents(news!.components);

          // 1. Observe — the live configuration is authoritative.
          const observed = yield* describe(scraperId);

          // 2/3. Ensure + sync — `updateScraperLoggingConfiguration` is an
          // upsert (there is no separate create operation); apply it only
          // when the destination or components drift.
          const drifts =
            observed === undefined ||
            observed.loggingDestination.cloudWatchLogs.logGroupArn !==
              desiredArn ||
            (desiredComponents !== undefined &&
              canonicalComponents(desiredComponents) !==
                canonicalComponents(observed.scraperComponents));

          if (drifts) {
            yield* amp
              .updateScraperLoggingConfiguration({
                scraperId,
                loggingDestination: {
                  cloudWatchLogs: { logGroupArn: desiredArn },
                },
                scraperComponents: desiredComponents,
              })
              .pipe(
                // The scraper (or a previous logging update) may still be
                // transitioning — retry conflicts briefly.
                Effect.retry({
                  while: (e) => e._tag === "ConflictException",
                  schedule: Schedule.max([
                    Schedule.fixed("6 seconds"),
                    Schedule.recurs(15),
                  ]),
                }),
              );
          }

          // Bounded best-effort wait toward ACTIVE — a still-transitioning
          // configuration converges on a later reconcile.
          const fresh = yield* amp
            .describeScraperLoggingConfiguration({ scraperId })
            .pipe(
              Effect.repeat({
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(20),
                ]),
                until: (c): boolean => c.status.statusCode === "ACTIVE",
              }),
            );
          yield* session.note(scraperId);
          return toAttrs(fresh);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp
            .deleteScraperLoggingConfiguration({
              scraperId: output.scraperId,
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

        // Singleton sub-resource keyed by its parent scraper.
        list: () => Effect.succeed([]),
      };
    }),
  );
