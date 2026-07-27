import * as securitylake from "@distilled.cloud/aws/securitylake";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryWhileConflict } from "./internal.ts";

/**
 * The Glue crawler configuration Security Lake uses to catalog the custom
 * source's OCSF data.
 */
export interface CustomLogSourceCrawlerConfiguration {
  /**
   * ARN of the IAM role the Glue crawler assumes. The role must be assumable
   * by `glue.amazonaws.com` and grant access to the Security Lake bucket
   * prefix for this source.
   */
  roleArn: string;
}

/**
 * The AWS identity (principal + external ID) the custom-source provider uses
 * to write data into the data lake.
 */
export interface CustomLogSourceProviderIdentity {
  /** The AWS account ID (or principal) of the log provider. */
  principal: string;
  /** The external ID the provider must present when assuming the role. */
  externalId: string;
}

export interface CustomLogSourceProps {
  /**
   * Name of the custom log source. Must be unique per account/Region.
   * If omitted, a unique physical name is generated from the app, stage,
   * and logical ID. Changing this replaces the source.
   */
  sourceName?: string;

  /**
   * The version of the custom source schema. Changing this replaces the
   * source.
   * @default - Security Lake assigns a version
   */
  sourceVersion?: string;

  /**
   * The Open Cybersecurity Schema Framework (OCSF) event classes the source
   * emits (e.g. `FILE_ACTIVITY`, `DNS_ACTIVITY`). Changing this replaces the
   * source.
   */
  eventClasses?: string[];

  /**
   * The Glue crawler configuration for cataloging the source's data.
   * Changing this replaces the source.
   */
  crawlerConfiguration: CustomLogSourceCrawlerConfiguration;

  /**
   * The AWS identity of the provider that writes this source's data.
   * Changing this replaces the source.
   */
  providerIdentity: CustomLogSourceProviderIdentity;
}

/** @resource */
export interface CustomLogSource extends Resource<
  "AWS.SecurityLake.CustomLogSource",
  CustomLogSourceProps,
  {
    /** Name of the custom log source. */
    sourceName: string;
    /** The resolved source schema version. */
    sourceVersion: string | undefined;
    /** ARN of the Glue crawler created for the source. */
    crawlerArn: string | undefined;
    /** ARN of the Glue database created for the source. */
    databaseArn: string | undefined;
    /** ARN of the Glue table created for the source. */
    tableArn: string | undefined;
    /** ARN of the IAM role the provider assumes to write data. */
    providerRoleArn: string | undefined;
    /** S3 location the provider writes OCSF data to. */
    providerLocation: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom (third-party) log source registered with Amazon Security Lake.
 * Security Lake provisions a Glue crawler, database, and table for the
 * source, plus an IAM role the provider assumes to write OCSF-formatted data
 * into the data lake. Requires `SecurityLake.DataLake` to already be enabled
 * in the Region.
 *
 * Every configuration property is create-only — changing any of them
 * replaces the source.
 *
 * @section Registering a custom source
 * @example Custom source with a crawler role
 * ```typescript
 * const custom = yield* SecurityLake.CustomLogSource("AppLogs", {
 *   sourceName: "my-app-logs",
 *   eventClasses: ["FILE_ACTIVITY"],
 *   crawlerConfiguration: { roleArn: crawlerRole.roleArn },
 *   providerIdentity: {
 *     principal: "123456789012",
 *     externalId: "my-app-external-id",
 *   },
 * });
 * ```
 */
const CustomLogSourceResource = Resource<CustomLogSource>(
  "AWS.SecurityLake.CustomLogSource",
);

export { CustomLogSourceResource as CustomLogSource };

const buildAttrs = (source: securitylake.CustomLogSourceResource) => ({
  sourceName: source.sourceName!,
  sourceVersion: source.sourceVersion,
  crawlerArn: source.attributes?.crawlerArn,
  databaseArn: source.attributes?.databaseArn,
  tableArn: source.attributes?.tableArn,
  providerRoleArn: source.provider?.roleArn,
  providerLocation: source.provider?.location,
});

export const CustomLogSourceProvider = () =>
  Provider.effect(
    CustomLogSourceResource,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { sourceName?: string },
      ) {
        return (
          props.sourceName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      // listLogSources reports only the source identity (name + version) for
      // custom sources — the Glue/provider attributes are only returned by
      // createCustomLogSource, so `output` is the cache for those.
      const findByName = (
        sourceName: string,
        sourceVersion: string | undefined,
      ) =>
        securitylake.listLogSources.items({}).pipe(
          Stream.map((entry) => entry.sources ?? []),
          Stream.flattenIterable,
          Stream.filter(
            (source) =>
              source.customLogSource?.sourceName === sourceName &&
              (sourceVersion === undefined ||
                source.customLogSource.sourceVersion === sourceVersion),
          ),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
          Effect.map((source) => source?.customLogSource),
        );

      return {
        read: Effect.fn(function* ({ id, olds, output }) {
          const sourceName =
            output?.sourceName ?? (yield* createName(id, olds ?? {}));
          const sourceVersion = output?.sourceVersion ?? olds?.sourceVersion;
          // An account that never onboarded Security Lake rejects
          // listLogSources — that means "no source", not a failure.
          const observed = yield* findByName(sourceName, sourceVersion).pipe(
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "UnauthorizedException",
              ],
              () => Effect.succeed(undefined),
            ),
          );
          if (observed === undefined) return undefined;
          // Custom log sources carry no tags, so ownership can't be
          // distinguished — read reports observed state (merged with cached
          // create-time attributes).
          return {
            sourceName,
            sourceVersion: observed.sourceVersion ?? sourceVersion,
            crawlerArn: output?.crawlerArn,
            databaseArn: output?.databaseArn,
            tableArn: output?.tableArn,
            providerRoleArn: output?.providerRoleArn,
            providerLocation: output?.providerLocation,
          };
        }),

        list: () =>
          securitylake.listLogSources.items({}).pipe(
            Stream.map((entry) => entry.sources ?? []),
            Stream.flattenIterable,
            Stream.runCollect,
            Effect.map((entries) => {
              const seen = new Set<string>();
              const attrs: ReturnType<typeof buildAttrs>[] = [];
              for (const entry of entries) {
                const source = entry.customLogSource;
                if (source?.sourceName === undefined) continue;
                const key = `${source.sourceName}@${source.sourceVersion ?? ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                attrs.push(buildAttrs(source));
              }
              return attrs;
            }),
            // An account that never onboarded Security Lake has no data lake
            // to list sources for.
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "UnauthorizedException",
              ],
              () => Effect.succeed([]),
            ),
          ),

        // There is no UpdateCustomLogSource — every property is create-only.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const changed =
            news.sourceName !== olds.sourceName ||
            news.sourceVersion !== olds.sourceVersion ||
            JSON.stringify(news.eventClasses ?? []) !==
              JSON.stringify(olds.eventClasses ?? []) ||
            news.crawlerConfiguration.roleArn !==
              olds.crawlerConfiguration.roleArn ||
            news.providerIdentity.principal !==
              olds.providerIdentity.principal ||
            news.providerIdentity.externalId !==
              olds.providerIdentity.externalId;
          if (changed) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const sourceName = yield* createName(id, news);

          // 1. OBSERVE — is the source already registered?
          const observed = yield* findByName(sourceName, news.sourceVersion);

          // 2. ENSURE — create when missing. A ConflictException means a
          // concurrent create won the race; fall through to observation.
          let attrs = output;
          if (observed === undefined) {
            const created = yield* securitylake
              .createCustomLogSource({
                sourceName,
                sourceVersion: news.sourceVersion,
                eventClasses: news.eventClasses,
                configuration: {
                  crawlerConfiguration: news.crawlerConfiguration,
                  providerIdentity: news.providerIdentity,
                },
              })
              .pipe(
                Effect.map((response) => response.source),
                // A concurrent create won the race — keep cached attributes.
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (created !== undefined) {
              attrs = buildAttrs(created);
            }
          }

          // 3. RETURN — merge observed identity with cached create-time
          // attributes (Glue ARNs / provider role are only reported by
          // create).
          const final = {
            sourceName,
            sourceVersion:
              attrs?.sourceVersion ??
              observed?.sourceVersion ??
              news.sourceVersion,
            crawlerArn: attrs?.crawlerArn,
            databaseArn: attrs?.databaseArn,
            tableArn: attrs?.tableArn,
            providerRoleArn: attrs?.providerRoleArn,
            providerLocation: attrs?.providerLocation,
          };
          yield* session.note(sourceName);
          return final;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* securitylake
            .deleteCustomLogSource({
              sourceName: output.sourceName,
              sourceVersion: output.sourceVersion,
            })
            .pipe(
              retryWhileConflict,
              // Gone already, or the data lake itself was offboarded first.
              Effect.catchTag(
                [
                  "AccessDeniedException",
                  "ResourceNotFoundException",
                  "UnauthorizedException",
                ],
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
