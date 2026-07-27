import * as oam from "@distilled.cloud/aws/oam";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteLinkAndWait,
  readOamTags,
  retryOamMutation,
  syncOamTags,
} from "./internal.ts";

/**
 * The telemetry resource types that can be shared over a link.
 */
export type LinkResourceType =
  | "AWS::CloudWatch::Metric"
  | "AWS::Logs::LogGroup"
  | "AWS::XRay::Trace"
  | "AWS::ApplicationInsights::Application"
  | "AWS::InternetMonitor::Monitor"
  | "AWS::ApplicationSignals::Service"
  | "AWS::ApplicationSignals::ServiceLevelObjective"
  | (string & {});

export interface LinkProps {
  /**
   * How the link's label appears in the monitoring account. Variables:
   * `$AccountName`, `$AccountEmail`, `$AccountEmailNoDomain`.
   * Changing the label template replaces the link.
   */
  labelTemplate: string;

  /**
   * The telemetry resource types shared from this source account to the
   * monitoring account, e.g. `AWS::CloudWatch::Metric`,
   * `AWS::Logs::LogGroup`, `AWS::XRay::Trace`.
   */
  resourceTypes: LinkResourceType[];

  /**
   * The ARN of the monitoring-account sink to attach to. The sink's policy
   * must permit this account to link. Changing the sink replaces the link.
   * Must be in a **different** account — OAM rejects a link to a sink in
   * the same account.
   */
  sinkIdentifier: string;

  /**
   * Optional filters restricting which log groups and metric namespaces
   * are shared to the monitoring account.
   */
  linkConfiguration?: {
    /**
     * Filter (OAM filter syntax) selecting which log groups are shared,
     * e.g. `LogGroupName LIKE 'aws/lambda/%'`.
     */
    logGroupConfiguration?: { filter: string };
    /**
     * Filter selecting which metric namespaces are shared, e.g.
     * `Namespace NOT LIKE 'AWS/%'`.
     */
    metricConfiguration?: { filter: string };
  };

  /**
   * User tags to attach to the link. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Link extends Resource<
  "AWS.OAM.Link",
  LinkProps,
  {
    /** The ARN of the link. */
    linkArn: string;
    /** The random ID string that AWS generated as part of the link ARN. */
    linkId: string;
    /** The label that this link displays in the monitoring account. */
    label: string;
    /** The ARN of the sink this link is attached to. */
    sinkArn: string;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch cross-account observability **link** — created in a source
 * account, it attaches to a monitoring-account {@link Sink} and shares the
 * selected telemetry types (metrics, log groups, traces, Application
 * Signals) with that account.
 *
 * The sink must live in a **different** account and its sink policy must
 * authorize this account to link.
 *
 * @resource
 * @section Creating a Link
 * @example Share metrics and logs with a monitoring account
 * ```typescript
 * import * as OAM from "alchemy/AWS/OAM";
 *
 * const link = yield* OAM.Link("ToMonitoring", {
 *   labelTemplate: "$AccountName",
 *   resourceTypes: ["AWS::CloudWatch::Metric", "AWS::Logs::LogGroup"],
 *   sinkIdentifier:
 *     "arn:aws:oam:us-west-2:111122223333:sink/1c72e9ec-4d4a-4e...",
 * });
 * ```
 *
 * @example Filter what is shared
 * ```typescript
 * const link = yield* OAM.Link("FilteredLink", {
 *   labelTemplate: "$AccountName",
 *   resourceTypes: ["AWS::CloudWatch::Metric", "AWS::Logs::LogGroup"],
 *   sinkIdentifier: sinkArn,
 *   linkConfiguration: {
 *     logGroupConfiguration: { filter: "LogGroupName LIKE 'aws/lambda/%'" },
 *     metricConfiguration: { filter: "Namespace NOT LIKE 'AWS/%'" },
 *   },
 * });
 * ```
 */
export const Link = Resource<Link>("AWS.OAM.Link");

const toLinkConfiguration = (
  config: LinkProps["linkConfiguration"],
): oam.LinkConfiguration | undefined =>
  config === undefined
    ? undefined
    : {
        ...(config.logGroupConfiguration
          ? {
              LogGroupConfiguration: {
                Filter: config.logGroupConfiguration.filter,
              },
            }
          : {}),
        ...(config.metricConfiguration
          ? {
              MetricConfiguration: {
                Filter: config.metricConfiguration.filter,
              },
            }
          : {}),
      };

const sameResourceTypes = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean =>
  JSON.stringify([...(a ?? [])].sort()) ===
  JSON.stringify([...(b ?? [])].sort());

const sameLinkConfiguration = (
  a: oam.LinkConfiguration | undefined,
  b: oam.LinkConfiguration | undefined,
): boolean =>
  (a?.LogGroupConfiguration?.Filter ?? null) ===
    (b?.LogGroupConfiguration?.Filter ?? null) &&
  (a?.MetricConfiguration?.Filter ?? null) ===
    (b?.MetricConfiguration?.Filter ?? null);

export const LinkProvider = () =>
  Provider.effect(
    Link,
    Effect.gen(function* () {
      const getLinkByArn = Effect.fn(function* (linkArn: string) {
        return yield* oam
          .getLink({ Identifier: linkArn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Link.Provider.of({
        stables: ["linkArn", "linkId", "label", "sinkArn"],
        list: () =>
          oam.listLinks.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                page.Items.filter(
                  (item) => item.Arn != null && item.Id != null,
                ).map((item) => ({
                  linkArn: item.Arn!,
                  linkId: item.Id!,
                  label: item.Label ?? "",
                  sinkArn: item.SinkArn ?? "",
                })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, output }) {
          // Links are identified by an auto-assigned ARN. With a cached ARN
          // we look it up directly; without one (state persistence failed
          // before the ARN landed) we scan the account's links for the one
          // carrying our ownership tags.
          if (output?.linkArn) {
            const found = yield* getLinkByArn(output.linkArn);
            if (!found?.Arn) return undefined;
            return {
              linkArn: found.Arn,
              linkId: found.Id!,
              label: found.Label ?? "",
              sinkArn: found.SinkArn ?? "",
            };
          }
          const pages = yield* oam.listLinks.pages({}).pipe(Stream.runCollect);
          const items = Array.from(pages).flatMap((page) => page.Items);
          for (const item of items) {
            if (item.Arn == null) continue;
            const tags = yield* readOamTags(item.Arn);
            if (yield* hasAlchemyTags(id, tags)) {
              return {
                linkArn: item.Arn,
                linkId: item.Id!,
                label: item.Label ?? "",
                sinkArn: item.SinkArn ?? "",
              };
            }
          }
          return undefined;
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // The label template and the target sink are immutable —
          // UpdateLink only changes resource types and filters.
          if (news.labelTemplate !== olds.labelTemplate) {
            return { action: "replace" } as const;
          }
          if (news.sinkIdentifier !== olds.sinkIdentifier) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredConfiguration = toLinkConfiguration(
            news.linkConfiguration,
          );

          // OBSERVE — the cached ARN is only a hint; a deleted link falls
          // through to create.
          let live = output?.linkArn
            ? yield* getLinkByArn(output.linkArn)
            : undefined;

          // ENSURE
          if (live?.Arn == null) {
            live = yield* retryOamMutation(
              oam.createLink({
                LabelTemplate: news.labelTemplate,
                ResourceTypes: news.resourceTypes,
                SinkIdentifier: news.sinkIdentifier,
                LinkConfiguration: desiredConfiguration,
                Tags: news.tags,
              }),
            );
          }
          const linkArn = live!.Arn!;

          // SYNC — resource types + filters, diffed against observed state.
          if (
            !sameResourceTypes(live!.ResourceTypes, news.resourceTypes) ||
            !sameLinkConfiguration(
              live!.LinkConfiguration,
              desiredConfiguration,
            )
          ) {
            live = yield* retryOamMutation(
              oam.updateLink({
                Identifier: linkArn,
                ResourceTypes: news.resourceTypes,
                LinkConfiguration: desiredConfiguration,
              }),
            );
          }

          // SYNC tags — against observed cloud tags (adoption-safe).
          yield* syncOamTags(linkArn, id, news.tags);

          yield* session.note(linkArn);
          return {
            linkArn,
            linkId: live!.Id!,
            label: live!.Label ?? "",
            sinkArn: live!.SinkArn ?? "",
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteLinkAndWait(output.linkArn);
        }),
      });
    }),
  );
