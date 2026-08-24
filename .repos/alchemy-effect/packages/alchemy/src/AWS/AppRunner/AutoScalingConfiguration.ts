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
 * Derive the revision-less "name partial" ARN
 * (`...:autoscalingconfiguration/{name}`) from any configuration ARN.
 * `DeleteAllRevisions` rejects revision-qualified ARNs (observed live:
 * "You cannot specify full auto scaling configuration ARN and
 * DeleteAllRevisions as true at same time").
 */
const toNamePartialArn = (arn: string): string =>
  // "arn:...:autoscalingconfiguration/{name}/{revision}/{uuid}" -> keep
  // everything up to and including {name}.
  arn.split("/").slice(0, 2).join("/");

export interface AutoScalingConfigurationProps {
  /**
   * Name of the auto scaling configuration. Must be 4-32 characters
   * (letters, digits, hyphens, underscores). If omitted, a deterministic
   * physical name is generated. Changing the name replaces the
   * configuration (all revisions of the old name are deleted).
   */
  autoScalingConfigurationName?: string;
  /**
   * Maximum number of concurrent requests an instance processes before
   * App Runner scales up.
   * @default 100
   */
  maxConcurrency?: number;
  /**
   * Minimum number of provisioned (warm) instances. Higher values spread
   * the service over more Availability Zones at a higher minimal cost.
   * @default 1
   */
  minSize?: number;
  /**
   * Maximum number of instances the service scales up to.
   * @default 25
   */
  maxSize?: number;
  /**
   * User-defined tags for the configuration.
   */
  tags?: Record<string, string>;
}

export interface AutoScalingConfiguration extends Resource<
  "AWS.AppRunner.AutoScalingConfiguration",
  AutoScalingConfigurationProps,
  {
    /**
     * Name of the auto scaling configuration.
     */
    autoScalingConfigurationName: string;
    /**
     * ARN of this auto scaling configuration revision.
     */
    autoScalingConfigurationArn: string;
    /**
     * Revision number of the configuration (revisions are immutable).
     */
    autoScalingConfigurationRevision: number;
    /**
     * Maximum concurrent requests per instance before scaling out.
     */
    maxConcurrency: number | undefined;
    /**
     * Minimum number of provisioned instances.
     */
    minSize: number | undefined;
    /**
     * Maximum number of instances the service may scale out to.
     */
    maxSize: number | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS App Runner auto scaling configuration.
 *
 * Auto scaling configurations are immutable revisions: changing
 * `maxConcurrency`, `minSize`, or `maxSize` creates a new revision under
 * the same name (the ARN and revision attributes change). A configuration
 * can be shared across multiple App Runner services.
 * @resource
 * @section Creating an Auto Scaling Configuration
 * @example Basic Configuration
 * ```typescript
 * const scaling = yield* AppRunner.AutoScalingConfiguration("Scaling", {
 *   maxConcurrency: 50,
 *   minSize: 1,
 *   maxSize: 3,
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
 *   autoScalingConfigurationArn: scaling.autoScalingConfigurationArn,
 * });
 * ```
 */
export const AutoScalingConfiguration = Resource<AutoScalingConfiguration>(
  "AWS.AppRunner.AutoScalingConfiguration",
);

export const AutoScalingConfigurationProvider = () =>
  Provider.effect(
    AutoScalingConfiguration,
    Effect.gen(function* () {
      const toName = (id: string, props: AutoScalingConfigurationProps) =>
        props.autoScalingConfigurationName
          ? Effect.succeed(props.autoScalingConfigurationName)
          : createPhysicalName({ id, maxLength: 32 });

      /** Find the latest ACTIVE revision of a configuration by name. */
      const findLatest = Effect.fn(function* (name: string) {
        const page = yield* apprunner.listAutoScalingConfigurations({
          AutoScalingConfigurationName: name,
          LatestOnly: true,
        });
        const summary = (page.AutoScalingConfigurationSummaryList ?? []).find(
          (s) =>
            s.AutoScalingConfigurationName === name &&
            isActiveStatus(s.Status) &&
            s.AutoScalingConfigurationArn !== undefined,
        );
        if (!summary?.AutoScalingConfigurationArn) return undefined;
        const described = yield* apprunner
          .describeAutoScalingConfiguration({
            AutoScalingConfigurationArn: summary.AutoScalingConfigurationArn,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const config = described?.AutoScalingConfiguration;
        return config !== undefined && isActiveStatus(config.Status)
          ? config
          : undefined;
      });

      const toAttrs = Effect.fn(function* (
        config: apprunner.AutoScalingConfiguration,
      ) {
        if (
          !config.AutoScalingConfigurationName ||
          !config.AutoScalingConfigurationArn ||
          config.AutoScalingConfigurationRevision === undefined
        ) {
          return yield* Effect.fail(
            new Error(
              "App Runner auto scaling configuration is missing its name, ARN, or revision",
            ),
          );
        }
        return {
          autoScalingConfigurationName: config.AutoScalingConfigurationName,
          autoScalingConfigurationArn: config.AutoScalingConfigurationArn,
          autoScalingConfigurationRevision:
            config.AutoScalingConfigurationRevision,
          maxConcurrency: config.MaxConcurrency,
          minSize: config.MinSize,
          maxSize: config.MaxSize,
        };
      });

      return {
        stables: ["autoScalingConfigurationName"],

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
            output?.autoScalingConfigurationName ??
            (yield* toName(id, olds ?? {}));
          const config = yield* findLatest(name);
          if (config === undefined) return undefined;
          const attrs = yield* toAttrs(config);
          const tags = yield* readAppRunnerTags(
            attrs.autoScalingConfigurationArn,
          );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name =
            output?.autoScalingConfigurationName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — the latest ACTIVE revision is authoritative.
          let observed = yield* findLatest(name);

          // 2/3. Ensure + sync — scaling settings live on immutable
          // revisions, so a drift on any user-specified field is converged
          // by creating a new revision under the same name. Only compare
          // fields the user actually specified: the service fills in
          // defaults that must not trigger spurious revisions.
          const drifted =
            observed !== undefined &&
            ((news.maxConcurrency !== undefined &&
              news.maxConcurrency !== observed.MaxConcurrency) ||
              (news.minSize !== undefined &&
                news.minSize !== observed.MinSize) ||
              (news.maxSize !== undefined &&
                news.maxSize !== observed.MaxSize));

          if (observed === undefined || drifted) {
            const created = yield* apprunner.createAutoScalingConfiguration({
              AutoScalingConfigurationName: name,
              MaxConcurrency: news.maxConcurrency,
              MinSize: news.minSize,
              MaxSize: news.maxSize,
              Tags: toWireTags(desiredTags),
            });
            observed = created.AutoScalingConfiguration;
          }

          // 3b. Sync tags on the latest revision ARN — diff against
          // OBSERVED cloud tags.
          if (observed.AutoScalingConfigurationArn) {
            yield* syncAppRunnerTags(
              observed.AutoScalingConfigurationArn,
              desiredTags,
            );
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteAllRevisions removes every revision that shares the
          // configuration name; it requires the revision-less name partial
          // ARN. A configuration still referenced by a service (App Runner
          // releases the association asynchronously after the service
          // finishes deleting) rejects with InvalidRequestException —
          // retry through that window (bounded).
          yield* apprunner
            .deleteAutoScalingConfiguration({
              AutoScalingConfigurationArn: toNamePartialArn(
                output.autoScalingConfigurationArn,
              ),
              DeleteAllRevisions: true,
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
        }),

        list: () =>
          apprunner.listAutoScalingConfigurations
            .pages({ LatestOnly: true })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.AutoScalingConfigurationSummaryList ?? []).filter(
                    (
                      s,
                    ): s is apprunner.AutoScalingConfigurationSummary & {
                      AutoScalingConfigurationArn: string;
                    } =>
                      isActiveStatus(s.Status) &&
                      s.AutoScalingConfigurationArn !== undefined &&
                      // App Runner ships an AWS-managed `DefaultConfiguration`
                      // revision that always exists and can never be deleted
                      // — keep it out of enumeration for account-wide
                      // teardown (nuke).
                      s.AutoScalingConfigurationName !== "DefaultConfiguration",
                  ),
                ),
              ),
              Effect.flatMap(
                Effect.forEach(
                  (summary) =>
                    apprunner
                      .describeAutoScalingConfiguration({
                        AutoScalingConfigurationArn:
                          summary.AutoScalingConfigurationArn,
                      })
                      .pipe(
                        Effect.flatMap((r) =>
                          toAttrs(r.AutoScalingConfiguration),
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
