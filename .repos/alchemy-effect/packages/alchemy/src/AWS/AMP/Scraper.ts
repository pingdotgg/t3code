import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  decodeDefinition,
  encodeDefinition,
  syncAmpTags,
  toTagRecord,
} from "./internal.ts";

export interface ScraperEksSource {
  /**
   * ARN of the Amazon EKS cluster the scraper collects metrics from.
   */
  clusterArn: string;
  /**
   * IDs of the subnets the scraper's network interfaces are placed in. Must
   * be subnets of the cluster's VPC.
   */
  subnetIds: string[];
  /**
   * IDs of the security groups applied to the scraper's network interfaces.
   * If omitted, the cluster's default security group is used.
   */
  securityGroupIds?: string[];
}

export interface ScraperVpcSource {
  /**
   * IDs of the subnets the scraper's network interfaces are placed in.
   */
  subnetIds: string[];
  /**
   * IDs of the security groups applied to the scraper's network interfaces.
   */
  securityGroupIds: string[];
}

/**
 * Where the scraper collects metrics from — an Amazon EKS cluster or a
 * VPC-based source (Amazon MSK, self-managed Kubernetes, or any
 * Prometheus-compatible endpoint discoverable via DNS in the VPC).
 */
export type ScraperSource =
  | { eksConfiguration: ScraperEksSource }
  | { vpcConfiguration: ScraperVpcSource };

export interface ScraperRoleConfiguration {
  /**
   * ARN of the role used by the scraper to discover and collect metrics on
   * your behalf (cross-account collection).
   */
  sourceRoleArn?: string;
  /**
   * ARN of the role used by the scraper to write to the destination
   * workspace (cross-account collection).
   */
  targetRoleArn?: string;
}

export interface ScraperProps {
  /**
   * A human-readable alias for the scraper. Aliases are not unique.
   * Updating the alias is an in-place update.
   */
  alias?: string;
  /**
   * The scraper's configuration as Prometheus scrape-configuration YAML
   * text. It is base64-blob encoded on the wire automatically. Use the
   * {@link GetDefaultScraperConfiguration} binding (or the
   * `GetDefaultScraperConfiguration` API) to fetch the AWS-managed default
   * as a starting point. Updating the configuration is an in-place update.
   */
  scrapeConfiguration: string;
  /**
   * Where the scraper collects metrics from. The source is immutable —
   * changing it replaces the scraper.
   */
  source: ScraperSource;
  /**
   * ARN of the Amazon Managed Service for Prometheus workspace the scraped
   * metrics are written to. Updating the destination is an in-place update.
   */
  destinationWorkspaceArn: string;
  /**
   * Cross-account role configuration for the scraper. If omitted, the
   * scraper collects and writes within the current account using the
   * service-created role.
   */
  roleConfiguration?: ScraperRoleConfiguration;
  /**
   * User-defined tags for the scraper.
   */
  tags?: Record<string, string>;
}

export interface Scraper extends Resource<
  "AWS.AMP.Scraper",
  ScraperProps,
  {
    scraperId: string;
    scraperArn: string;
    roleArn: string;
    alias: string | undefined;
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Managed Service for Prometheus scraper — a fully-managed,
 * agentless collector that pulls metrics from an Amazon EKS cluster (or a
 * VPC-based Prometheus-compatible source) and remote-writes them into an AMP
 * workspace.
 *
 * Scraper provisioning is slow (the service creates network interfaces and
 * an IAM role; expect several minutes to reach `ACTIVE`).
 *
 * @resource
 * @section Creating a Scraper
 * @example Scrape an EKS Cluster into a Workspace
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {});
 * const scraper = yield* AMP.Scraper("ClusterScraper", {
 *   alias: "eks-metrics",
 *   scrapeConfiguration: defaultScrapeConfigYaml,
 *   source: {
 *     eksConfiguration: {
 *       clusterArn: cluster.clusterArn,
 *       subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *     },
 *   },
 *   destinationWorkspaceArn: workspace.workspaceArn,
 * });
 * ```
 *
 * @example Scrape a VPC-Based Source
 * ```typescript
 * const scraper = yield* AMP.Scraper("VpcScraper", {
 *   scrapeConfiguration: scrapeConfigYaml,
 *   source: {
 *     vpcConfiguration: {
 *       subnetIds: [subnet.subnetId],
 *       securityGroupIds: [securityGroup.securityGroupId],
 *     },
 *   },
 *   destinationWorkspaceArn: workspace.workspaceArn,
 * });
 * ```
 */
export const Scraper = Resource<Scraper>("AWS.AMP.Scraper");

/** Canonical JSON of a scraper source for observed-vs-desired comparison. */
const canonicalSource = (source: ScraperSource): string => {
  const canonical = (config: {
    clusterArn?: string;
    subnetIds: string[];
    securityGroupIds?: string[];
  }) => ({
    clusterArn: config.clusterArn ?? null,
    subnetIds: [...config.subnetIds].sort(),
    securityGroupIds: [...(config.securityGroupIds ?? [])].sort(),
  });
  return "eksConfiguration" in source
    ? JSON.stringify({ eks: canonical(source.eksConfiguration) })
    : JSON.stringify({ vpc: canonical(source.vpcConfiguration) });
};

export const ScraperProvider = () =>
  Provider.effect(
    Scraper,
    Effect.gen(function* () {
      const toAttrs = (scraper: {
        scraperId: string;
        arn: string;
        roleArn: string;
        alias?: string;
        status: amp.ScraperStatus;
      }) => ({
        scraperId: scraper.scraperId,
        scraperArn: scraper.arn,
        roleArn: scraper.roleArn,
        alias: scraper.alias,
        status: scraper.status.statusCode,
      });

      /** Describe a scraper by id; typed not-found → undefined. */
      const describe = Effect.fn(function* (scraperId: string) {
        const response = yield* amp
          .describeScraper({ scraperId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.scraper;
      });

      const toWireSource = (source: ScraperSource): amp.Source =>
        "eksConfiguration" in source
          ? {
              eksConfiguration: {
                clusterArn: source.eksConfiguration.clusterArn,
                subnetIds: source.eksConfiguration.subnetIds,
                securityGroupIds: source.eksConfiguration.securityGroupIds,
              },
            }
          : {
              vpcConfiguration: {
                subnetIds: source.vpcConfiguration.subnetIds,
                securityGroupIds: source.vpcConfiguration.securityGroupIds,
              },
            };

      /**
       * Poll until the scraper leaves CREATING/UPDATING. Scraper
       * provisioning creates network interfaces in each subnet and can take
       * many minutes — the wait is bounded at 25 minutes and fails fast on a
       * *_FAILED terminal status.
       */
      const waitActive = Effect.fn(function* (scraperId: string) {
        const scraper = yield* amp.describeScraper({ scraperId }).pipe(
          Effect.map((r) => r.scraper),
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("15 seconds"),
              Schedule.recurs(100),
            ]),
            until: (s): boolean =>
              s.status.statusCode !== "CREATING" &&
              s.status.statusCode !== "UPDATING",
          }),
        );
        if (scraper.status.statusCode !== "ACTIVE") {
          return yield* Effect.fail(
            new Error(
              `AMP scraper ${scraperId} did not become ACTIVE (status: ${scraper.status.statusCode}${
                scraper.statusReason ? `: ${scraper.statusReason}` : ""
              })`,
            ),
          );
        }
        return scraper;
      });

      return {
        stables: ["scraperId", "scraperArn", "roleArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // The metric source is immutable — a change replaces the scraper.
          if (
            olds !== undefined &&
            canonicalSource(olds.source) !== canonicalSource(news.source)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          // Scraper ids are server-assigned; without an output cache there
          // is no deterministic identity to look up.
          if (!output?.scraperId) return undefined;
          const scraper = yield* describe(output.scraperId);
          if (scraper === undefined) return undefined;
          const attrs = toAttrs(scraper);
          const tags = toTagRecord(scraper.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news!.tags };
          const desiredConfig = news!.scrapeConfiguration;

          // 1. Observe — cloud state is authoritative; output is an id cache.
          let scraper =
            output?.scraperId !== undefined
              ? yield* describe(output.scraperId)
              : undefined;

          // 2. Ensure — create if missing, then wait for ACTIVE.
          if (scraper === undefined) {
            const created = yield* amp.createScraper({
              alias: news!.alias,
              scrapeConfiguration: {
                configurationBlob: yield* encodeDefinition(desiredConfig),
              },
              source: toWireSource(news!.source),
              destination: {
                ampConfiguration: {
                  workspaceArn: news!.destinationWorkspaceArn,
                },
              },
              roleConfiguration: news!.roleConfiguration,
              tags: desiredTags,
            });
            scraper = yield* waitActive(created.scraperId);
          }

          const scraperId = scraper.scraperId;

          // 3. Sync mutable aspects — diff OBSERVED state against desired
          // and issue a single update only when something drifted.
          const observedConfig = yield* decodeDefinition(
            scraper.scrapeConfiguration.configurationBlob,
          );
          const observedDestination =
            scraper.destination.ampConfiguration.workspaceArn;
          const aliasDrifts =
            (news!.alias ?? undefined) !== (scraper.alias ?? undefined);
          const configDrifts = observedConfig !== desiredConfig;
          const destinationDrifts =
            observedDestination !== news!.destinationWorkspaceArn;
          const roleDrifts =
            news!.roleConfiguration !== undefined &&
            ((news!.roleConfiguration.sourceRoleArn ?? undefined) !==
              (scraper.roleConfiguration?.sourceRoleArn ?? undefined) ||
              (news!.roleConfiguration.targetRoleArn ?? undefined) !==
                (scraper.roleConfiguration?.targetRoleArn ?? undefined));

          if (aliasDrifts || configDrifts || destinationDrifts || roleDrifts) {
            yield* amp.updateScraper({
              scraperId,
              alias: news!.alias,
              scrapeConfiguration: configDrifts
                ? {
                    configurationBlob: yield* encodeDefinition(desiredConfig),
                  }
                : undefined,
              destination: destinationDrifts
                ? {
                    ampConfiguration: {
                      workspaceArn: news!.destinationWorkspaceArn,
                    },
                  }
                : undefined,
              roleConfiguration: roleDrifts
                ? news!.roleConfiguration
                : undefined,
            });
            scraper = yield* waitActive(scraperId);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAmpTags(scraper.arn, desiredTags);

          yield* session.note(scraperId);
          return toAttrs(scraper);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp.deleteScraper({ scraperId: output.scraperId }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A scraper mid-transition rejects deletion; retry briefly.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([
                Schedule.fixed("10 seconds"),
                Schedule.recurs(30),
              ]),
            }),
          );
        }),

        list: () =>
          amp.listScrapers.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                page.scrapers.map((summary) => toAttrs(summary)),
              ),
            ),
          ),
      };
    }),
  );
