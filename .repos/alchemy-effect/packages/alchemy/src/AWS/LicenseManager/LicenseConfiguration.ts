import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Dimension used to track license inventory.
 */
export type LicenseCountingType = "vCPU" | "Instance" | "Core" | "Socket";

export interface LicenseConfigurationProps {
  /**
   * Name of the license configuration.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Description of the license configuration.
   */
  description?: string;
  /**
   * Dimension used to track the license inventory: `vCPU`, `Instance`,
   * `Core`, or `Socket`. Cannot be changed after creation — changing it
   * replaces the license configuration.
   */
  licenseCountingType: LicenseCountingType;
  /**
   * Number of licenses managed by the license configuration.
   */
  licenseCount?: number;
  /**
   * Whether the number of licenses is a hard limit. A hard limit blocks
   * new instance launches once the license count is consumed.
   * @default false
   */
  licenseCountHardLimit?: boolean;
  /**
   * License rules (e.g. `#allowedTenancy=EC2-DedicatedHost`,
   * `#licenseAffinityToHost=30`). The rules allowed depend on the
   * license counting type.
   */
  licenseRules?: string[];
  /**
   * When true, disassociates a resource from the license configuration
   * when the resource is no longer found (e.g. the instance was
   * terminated).
   * @default false
   */
  disassociateWhenNotFound?: boolean;
  /**
   * Tags to apply to the license configuration. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface LicenseConfiguration extends Resource<
  "AWS.LicenseManager.LicenseConfiguration",
  LicenseConfigurationProps,
  {
    /**
     * Unique ID of the license configuration, e.g. `lic-0123abcd...`.
     */
    licenseConfigurationId: string;
    /**
     * ARN of the license configuration.
     */
    licenseConfigurationArn: string;
    /**
     * Name of the license configuration.
     */
    name: string;
    /**
     * Dimension used to track the license inventory.
     */
    licenseCountingType: string;
  },
  never,
  Providers
> {}

/**
 * An AWS License Manager license configuration — an abstraction of a
 * customer license agreement that License Manager can track and enforce.
 *
 * A license configuration specifies the licensing dimension (vCPUs,
 * instances, cores, or sockets), an optional license count, and whether
 * the count is a hard limit that blocks new launches once consumed.
 * @resource
 * @section Creating License Configurations
 * @example Track licenses by vCPU
 * ```typescript
 * import * as LicenseManager from "alchemy/AWS/LicenseManager";
 *
 * const licenses = yield* LicenseManager.LicenseConfiguration("Licenses", {
 *   licenseCountingType: "vCPU",
 * });
 * ```
 *
 * @example Enforce a hard license limit
 * ```typescript
 * const licenses = yield* LicenseManager.LicenseConfiguration("Licenses", {
 *   licenseCountingType: "Instance",
 *   licenseCount: 10,
 *   licenseCountHardLimit: true,
 * });
 * ```
 *
 * @example Socket licensing with dedicated-host rules
 * ```typescript
 * const licenses = yield* LicenseManager.LicenseConfiguration("Licenses", {
 *   licenseCountingType: "Socket",
 *   licenseCount: 4,
 *   licenseRules: ["#allowedTenancy=EC2-DedicatedHost"],
 *   description: "Oracle DB socket licenses",
 * });
 * ```
 */
export const LicenseConfiguration = Resource<LicenseConfiguration>(
  "AWS.LicenseManager.LicenseConfiguration",
);

/**
 * `DeleteLicenseConfiguration` soft-deletes: the configuration remains
 * visible with `Status: "DELETED"` for a while. Treat those as gone.
 */
const isLive = (status: string | undefined) => status !== "DELETED";

export const LicenseConfigurationProvider = () =>
  Provider.effect(
    LicenseConfiguration,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 96 }));
      });

      // Enumerate all license configurations (bounded manual pagination —
      // distilled exposes no `.pages` for this operation).
      const listAll = Effect.gen(function* () {
        const items: licensemanager.LicenseConfiguration[] = [];
        let nextToken: string | undefined;
        for (let page = 0; page < 50; page++) {
          const response = yield* licensemanager.listLicenseConfigurations({
            MaxResults: 100,
            ...(nextToken ? { NextToken: nextToken } : {}),
          });
          items.push(...(response.LicenseConfigurations ?? []));
          // Empty-string markers are terminal.
          if (!response.NextToken) break;
          nextToken = response.NextToken;
        }
        return items.filter((item) => isLive(item.Status));
      });

      const findByName = Effect.fn(function* (name: string) {
        const items = yield* listAll;
        return items.find((item) => item.Name === name);
      });

      // Observe a configuration by its ARN; a deleted/nonexistent ARN
      // surfaces as the typed not-found tag and maps to `undefined`.
      const getByArn = Effect.fn(function* (arn: string) {
        const found = yield* licensemanager
          .getLicenseConfiguration({ LicenseConfigurationArn: arn })
          .pipe(
            Effect.catchTag("LicenseConfigurationNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        if (found === undefined || !isLive(found.Status)) return undefined;
        return found;
      });

      // Distilled's `Tag` has optional `Key`/`Value`; narrow to a plain
      // record, dropping any entries the API returned without both fields.
      const toTagRecord = (
        tags: licensemanager.Tag[] | undefined,
      ): Record<string, string> => {
        const record: Record<string, string> = {};
        for (const tag of tags ?? []) {
          if (tag.Key !== undefined && tag.Value !== undefined) {
            record[tag.Key] = tag.Value;
          }
        }
        return record;
      };

      const toAttributes = (observed: {
        LicenseConfigurationId?: string;
        LicenseConfigurationArn?: string;
        Name?: string;
        LicenseCountingType?: string;
      }) => ({
        licenseConfigurationId: observed.LicenseConfigurationId!,
        licenseConfigurationArn: observed.LicenseConfigurationArn!,
        name: observed.Name!,
        licenseCountingType: observed.LicenseCountingType!,
      });

      return LicenseConfiguration.Provider.of({
        stables: [
          "licenseConfigurationId",
          "licenseConfigurationArn",
          "licenseCountingType",
        ],

        list: () =>
          Effect.gen(function* () {
            const items = yield* listAll;
            return items.map(toAttributes);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          let observed:
            | licensemanager.GetLicenseConfigurationResponse
            | undefined;
          if (output?.licenseConfigurationArn) {
            observed = yield* getByArn(output.licenseConfigurationArn);
          } else {
            const name = yield* createName(id, olds ?? {});
            const summary = yield* findByName(name);
            if (summary?.LicenseConfigurationArn) {
              observed = yield* getByArn(summary.LicenseConfigurationArn);
            }
          }
          if (observed === undefined) return undefined;
          const attrs = toAttributes(observed);
          const tags = toTagRecord(observed.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.licenseCountingType !== news.licenseCountingType) {
            return { action: "replace" } as const;
          }
          // Everything else (name, description, count, hard limit, rules,
          // tags) updates in place via the default update path.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...(news.tags ?? {}),
            ...internalTags,
          };

          // 1. OBSERVE — output is only an ARN cache; cloud state decides.
          let observed = output?.licenseConfigurationArn
            ? yield* getByArn(output.licenseConfigurationArn)
            : undefined;
          if (observed === undefined) {
            // State may have been lost (or this is an adoption without a
            // persisted ARN) — search by name before creating a duplicate.
            const summary = yield* findByName(name);
            if (summary?.LicenseConfigurationArn) {
              observed = yield* getByArn(summary.LicenseConfigurationArn);
            }
          }

          // 2. ENSURE — create when missing.
          if (observed === undefined) {
            const created = yield* licensemanager.createLicenseConfiguration({
              Name: name,
              Description: news.description,
              LicenseCountingType: news.licenseCountingType,
              LicenseCount: news.licenseCount,
              LicenseCountHardLimit: news.licenseCountHardLimit,
              LicenseRules: news.licenseRules,
              DisassociateWhenNotFound: news.disassociateWhenNotFound,
              Tags: createTagsList(desiredTags),
            });
            observed = yield* licensemanager.getLicenseConfiguration({
              LicenseConfigurationArn: created.LicenseConfigurationArn!,
            });
          }
          const arn = observed.LicenseConfigurationArn!;

          // 3. SYNC — diff each mutable aspect against OBSERVED cloud state
          //    and send only the delta.
          const update: Omit<
            licensemanager.UpdateLicenseConfigurationRequest,
            "LicenseConfigurationArn"
          > = {};
          if (observed.Name !== name) {
            update.Name = name;
          }
          if (
            news.description !== undefined &&
            observed.Description !== news.description
          ) {
            update.Description = news.description;
          }
          if (
            news.licenseCount !== undefined &&
            observed.LicenseCount !== news.licenseCount
          ) {
            update.LicenseCount = news.licenseCount;
          }
          const desiredHardLimit = news.licenseCountHardLimit ?? false;
          if ((observed.LicenseCountHardLimit ?? false) !== desiredHardLimit) {
            update.LicenseCountHardLimit = desiredHardLimit;
          }
          if (
            news.licenseRules !== undefined &&
            JSON.stringify(observed.LicenseRules ?? []) !==
              JSON.stringify(news.licenseRules)
          ) {
            update.LicenseRules = news.licenseRules;
          }
          const desiredDisassociate = news.disassociateWhenNotFound ?? false;
          if (
            (observed.DisassociateWhenNotFound ?? false) !== desiredDisassociate
          ) {
            update.DisassociateWhenNotFound = desiredDisassociate;
          }
          if (Object.keys(update).length > 0) {
            yield* licensemanager.updateLicenseConfiguration({
              LicenseConfigurationArn: arn,
              ...update,
            });
          }

          // 3b. SYNC TAGS — against observed cloud tags, never olds/output.
          const observedTags = toTagRecord(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* licensemanager.tagResource({
              ResourceArn: arn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* licensemanager.untagResource({
              ResourceArn: arn,
              TagKeys: removed,
            });
          }

          yield* session.note(arn);
          return {
            licenseConfigurationId: observed.LicenseConfigurationId!,
            licenseConfigurationArn: arn,
            name,
            licenseCountingType: observed.LicenseCountingType!,
          };
        }),

        // Idempotent: deleting an already-deleted (or never-existing)
        // configuration surfaces the typed not-found tag and is a no-op.
        delete: Effect.fn(function* ({ output }) {
          yield* licensemanager
            .deleteLicenseConfiguration({
              LicenseConfigurationArn: output.licenseConfigurationArn,
            })
            .pipe(
              Effect.catchTag(
                "LicenseConfigurationNotFound",
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
