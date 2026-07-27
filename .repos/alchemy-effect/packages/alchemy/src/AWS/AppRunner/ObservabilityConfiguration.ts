import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  isActiveStatus,
  readAppRunnerTags,
  syncAppRunnerTags,
  toWireTags,
} from "./internal.ts";

/**
 * Tracing configuration for an observability configuration.
 */
export interface ObservabilityTraceConfiguration {
  /**
   * The tracing vendor. `AWSXRAY` is the only supported vendor.
   */
  vendor: "AWSXRAY";
}

export interface ObservabilityConfigurationProps {
  /**
   * Name of the observability configuration. Must be 4-32 characters
   * (letters, digits, hyphens, underscores). If omitted, a deterministic
   * physical name is generated. Changing the name replaces the
   * configuration (all revisions of the old name are deleted).
   */
  observabilityConfigurationName?: string;
  /**
   * Tracing configuration. Omit to create a configuration with tracing
   * disabled (services referencing it emit no traces).
   */
  traceConfiguration?: ObservabilityTraceConfiguration;
  /**
   * User-defined tags for the configuration.
   */
  tags?: Record<string, string>;
}

export interface ObservabilityConfiguration extends Resource<
  "AWS.AppRunner.ObservabilityConfiguration",
  ObservabilityConfigurationProps,
  {
    /**
     * Name of the observability configuration.
     */
    observabilityConfigurationName: string;
    /**
     * ARN of this observability configuration revision.
     */
    observabilityConfigurationArn: string;
    /**
     * Revision number of the configuration (revisions are immutable).
     */
    observabilityConfigurationRevision: number;
    /**
     * The configured tracing vendor, if tracing is enabled.
     */
    traceVendor: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS App Runner observability configuration — enables AWS X-Ray tracing
 * for the App Runner services that reference it.
 *
 * Observability configurations are immutable revisions: changing
 * `traceConfiguration` creates a new revision under the same name (the ARN
 * and revision attributes change). A configuration can be shared across
 * multiple App Runner services.
 * @resource
 * @section Creating an Observability Configuration
 * @example X-Ray Tracing Configuration
 * ```typescript
 * const observability = yield* AppRunner.ObservabilityConfiguration("Tracing", {
 *   traceConfiguration: { vendor: "AWSXRAY" },
 * });
 * ```
 *
 * @section Using with an App Runner Service
 * @example Attach to a Service
 * ```typescript
 * const service = yield* AppRunner.Service("Api", {
 *   imageRepository: {
 *     imageIdentifier: "public.ecr.aws/aws-containers/hello-app-runner:latest",
 *     imageRepositoryType: "ECR_PUBLIC",
 *     port: "8000",
 *   },
 *   observabilityConfiguration: {
 *     observabilityEnabled: true,
 *     observabilityConfigurationArn:
 *       observability.observabilityConfigurationArn,
 *   },
 * });
 * ```
 */
export const ObservabilityConfiguration = Resource<ObservabilityConfiguration>(
  "AWS.AppRunner.ObservabilityConfiguration",
);

export const ObservabilityConfigurationProvider = () =>
  Provider.effect(
    ObservabilityConfiguration,
    Effect.gen(function* () {
      const toName = (id: string, props: ObservabilityConfigurationProps) =>
        props.observabilityConfigurationName
          ? Effect.succeed(props.observabilityConfigurationName)
          : createPhysicalName({ id, maxLength: 32 });

      /** Find the latest ACTIVE revision of a configuration by name. */
      const findLatest = Effect.fn(function* (name: string) {
        const page = yield* apprunner.listObservabilityConfigurations({
          ObservabilityConfigurationName: name,
          LatestOnly: true,
        });
        const summary = (page.ObservabilityConfigurationSummaryList ?? []).find(
          (s) =>
            s.ObservabilityConfigurationName === name &&
            s.ObservabilityConfigurationArn !== undefined,
        );
        if (!summary?.ObservabilityConfigurationArn) return undefined;
        const described = yield* apprunner
          .describeObservabilityConfiguration({
            ObservabilityConfigurationArn:
              summary.ObservabilityConfigurationArn,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const config = described?.ObservabilityConfiguration;
        return config !== undefined && isActiveStatus(config.Status)
          ? config
          : undefined;
      });

      const toAttrs = Effect.fn(function* (
        config: apprunner.ObservabilityConfiguration,
      ) {
        if (
          !config.ObservabilityConfigurationName ||
          !config.ObservabilityConfigurationArn ||
          config.ObservabilityConfigurationRevision === undefined
        ) {
          return yield* Effect.fail(
            new Error(
              "App Runner observability configuration is missing its name, ARN, or revision",
            ),
          );
        }
        return {
          observabilityConfigurationName: config.ObservabilityConfigurationName,
          observabilityConfigurationArn: config.ObservabilityConfigurationArn,
          observabilityConfigurationRevision:
            config.ObservabilityConfigurationRevision,
          traceVendor: config.TraceConfiguration?.Vendor,
        };
      });

      /**
       * Delete every ACTIVE revision that shares the configuration name.
       * `DeleteObservabilityConfiguration` has no `DeleteAllRevisions`
       * flag (unlike auto scaling configurations), so enumerate and delete
       * each revision. A revision still referenced by a service rejects
       * with InvalidRequestException — retry through that window (bounded).
       */
      const deleteAllRevisions = Effect.fn(function* (name: string) {
        const pages = yield* apprunner.listObservabilityConfigurations
          .pages({
            ObservabilityConfigurationName: name,
            LatestOnly: false,
          })
          .pipe(Stream.runCollect);
        const arns = Array.from(pages).flatMap((page) =>
          (page.ObservabilityConfigurationSummaryList ?? [])
            .filter((s) => s.ObservabilityConfigurationName === name)
            .flatMap((s) =>
              s.ObservabilityConfigurationArn !== undefined
                ? [s.ObservabilityConfigurationArn]
                : [],
            ),
        );
        for (const arn of arns) {
          yield* apprunner
            .deleteObservabilityConfiguration({
              ObservabilityConfigurationArn: arn,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "InvalidRequestException",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(24),
                ]),
              }),
            );
        }
      });

      return {
        stables: ["observabilityConfigurationName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.observabilityConfigurationName ??
            (yield* toName(id, olds ?? {}));
          const config = yield* findLatest(name);
          if (config === undefined) return undefined;
          const attrs = yield* toAttrs(config);
          const tags = yield* readAppRunnerTags(
            attrs.observabilityConfigurationArn,
          );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name =
            output?.observabilityConfigurationName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — the latest ACTIVE revision is authoritative.
          let observed = yield* findLatest(name);

          // 2/3. Ensure + sync — trace settings live on immutable
          // revisions, so a drift on the user-specified vendor is converged
          // by creating a new revision under the same name. Only compare
          // what the user actually specified.
          const drifted =
            observed !== undefined &&
            news.traceConfiguration !== undefined &&
            news.traceConfiguration.vendor !==
              observed.TraceConfiguration?.Vendor;

          if (observed === undefined || drifted) {
            const created = yield* apprunner.createObservabilityConfiguration({
              ObservabilityConfigurationName: name,
              TraceConfiguration: news.traceConfiguration
                ? { Vendor: news.traceConfiguration.vendor }
                : undefined,
              Tags: toWireTags(desiredTags),
            });
            observed = created.ObservabilityConfiguration;
          }

          // 3b. Sync tags on the latest revision ARN — diff against
          // OBSERVED cloud tags.
          if (observed.ObservabilityConfigurationArn) {
            yield* syncAppRunnerTags(
              observed.ObservabilityConfigurationArn,
              desiredTags,
            );
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteAllRevisions(output.observabilityConfigurationName);
        }),

        list: () =>
          apprunner.listObservabilityConfigurations
            .pages({ LatestOnly: true })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.ObservabilityConfigurationSummaryList ?? []).flatMap(
                    (s) =>
                      s.ObservabilityConfigurationArn !== undefined &&
                      // App Runner ships an AWS-managed `DefaultConfiguration`
                      // revision that always exists and can never be deleted
                      // — keep it out of enumeration for account-wide
                      // teardown (nuke).
                      s.ObservabilityConfigurationName !==
                        "DefaultConfiguration"
                        ? [s.ObservabilityConfigurationArn]
                        : [],
                  ),
                ),
              ),
              Effect.flatMap(
                Effect.forEach(
                  (arn) =>
                    apprunner
                      .describeObservabilityConfiguration({
                        ObservabilityConfigurationArn: arn,
                      })
                      .pipe(
                        Effect.flatMap((r) =>
                          isActiveStatus(r.ObservabilityConfiguration.Status)
                            ? Effect.map(
                                toAttrs(r.ObservabilityConfiguration),
                                (attrs) =>
                                  attrs as
                                    | ObservabilityConfiguration["Attributes"]
                                    | undefined,
                              )
                            : Effect.succeed(undefined),
                        ),
                        // Tolerate a delete race — drop the item.
                        Effect.catchTag("ResourceNotFoundException", () =>
                          Effect.succeed(undefined),
                        ),
                      ),
                  { concurrency: 4 },
                ),
              ),
              Effect.map((items) => items.filter((item) => item !== undefined)),
            ),
      };
    }),
  );
