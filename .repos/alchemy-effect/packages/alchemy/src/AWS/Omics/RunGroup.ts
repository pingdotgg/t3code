import * as omics from "@distilled.cloud/aws/omics";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireMinutes } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import { fetchOmicsTags, syncOmicsTags } from "./internal.ts";

export interface RunGroupProps {
  /**
   * A name for the run group. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Mutable.
   */
  name?: string;
  /**
   * The maximum number of vCPUs that can run concurrently across all active
   * runs in the group. Mutable.
   */
  maxCpus?: number;
  /**
   * The maximum number of concurrent runs for the group. Mutable.
   */
  maxRuns?: number;
  /**
   * The maximum time for each run in the group, e.g. `"10 hours"` or
   * `Duration.minutes(600)`. Sent to the API as whole minutes (a bare
   * number is milliseconds). Mutable.
   */
  maxDuration?: Duration.Input;
  /**
   * The maximum number of GPUs that can run concurrently across all active
   * runs in the group. Mutable.
   */
  maxGpus?: number;
  /**
   * Tags to apply to the run group. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface RunGroup extends Resource<
  "AWS.Omics.RunGroup",
  RunGroupProps,
  {
    /**
     * ID of the run group.
     */
    runGroupId: string;
    /**
     * ARN of the run group.
     */
    runGroupArn: string;
    /**
     * Name of the run group.
     */
    name: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon HealthOmics run group — a resource-limit envelope for workflow
 * runs. A run group caps the vCPUs, GPUs, concurrent runs, and per-run
 * duration for the workflow runs assigned to it.
 *
 * A run group name is auto-generated from the app, stage, and logical ID
 * unless you provide one. All limits are mutable in place.
 * @resource
 * @section Creating a Run Group
 * @example Basic Run Group
 * ```typescript
 * import * as Omics from "alchemy/AWS/Omics";
 *
 * const group = yield* Omics.RunGroup("Batch");
 * ```
 *
 * @example Run Group with Limits
 * ```typescript
 * const group = yield* Omics.RunGroup("Batch", {
 *   name: "nightly-batch",
 *   maxCpus: 100,
 *   maxRuns: 10,
 *   maxDuration: "10 hours",
 * });
 * ```
 */
export const RunGroup = Resource<RunGroup>("AWS.Omics.RunGroup");

export const RunGroupProvider = () =>
  Provider.effect(
    RunGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 96 }));
      });

      return RunGroup.Provider.of({
        stables: ["runGroupId", "runGroupArn"],
        list: () =>
          omics.listRunGroups.items({}).pipe(
            Stream.map((item) => ({
              runGroupId: item.id!,
              runGroupArn: item.arn!,
              name: item.name ?? "",
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
        read: Effect.fn(function* ({ id, output }) {
          if (output?.runGroupId === undefined) return undefined;
          const found = yield* omics
            .getRunGroup({ id: output.runGroupId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found === undefined || found.id === undefined) return undefined;
          const attrs = {
            runGroupId: found.id,
            runGroupArn: found.arn!,
            name: found.name ?? "",
          };
          const tags = yield* fetchOmicsTags(found.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        // No replacement path: every prop (name + limits) is mutable via
        // updateRunGroup. Return undefined to run the default update path.
        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const maxDurationMinutes = toWireMinutes(news.maxDuration);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // OBSERVE — the run group id is a server-generated cache.
          let group =
            output?.runGroupId === undefined
              ? undefined
              : yield* omics
                  .getRunGroup({ id: output.runGroupId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );

          // ENSURE — create if missing. `requestId` is a client idempotency
          // token; a stable value derived from the logical id keeps a retried
          // create from provisioning a duplicate group.
          if (group === undefined || group.id === undefined) {
            const created = yield* omics.createRunGroup({
              name,
              maxCpus: news.maxCpus,
              maxRuns: news.maxRuns,
              maxDuration: maxDurationMinutes,
              maxGpus: news.maxGpus,
              requestId: `alchemy-${id}`,
              tags: desiredTags,
            });
            group = yield* omics.getRunGroup({ id: created.id! });
          } else {
            // SYNC — apply the delta of mutable settings. Observed cloud state
            // is the diff baseline.
            const patch: {
              name?: string;
              maxCpus?: number;
              maxRuns?: number;
              maxDuration?: number;
              maxGpus?: number;
            } = {};
            if (news.name !== undefined && news.name !== group.name) {
              patch.name = news.name;
            }
            if (news.maxCpus !== undefined && news.maxCpus !== group.maxCpus) {
              patch.maxCpus = news.maxCpus;
            }
            if (news.maxRuns !== undefined && news.maxRuns !== group.maxRuns) {
              patch.maxRuns = news.maxRuns;
            }
            if (
              maxDurationMinutes !== undefined &&
              maxDurationMinutes !== group.maxDuration
            ) {
              patch.maxDuration = maxDurationMinutes;
            }
            if (news.maxGpus !== undefined && news.maxGpus !== group.maxGpus) {
              patch.maxGpus = news.maxGpus;
            }
            if (Object.keys(patch).length > 0) {
              yield* omics.updateRunGroup({ id: group.id, ...patch });
              group = yield* omics.getRunGroup({ id: group.id });
            }
          }

          // SYNC TAGS — diff against observed cloud tags so adoption converges.
          yield* syncOmicsTags(group.arn!, desiredTags);

          yield* session.note(group.id!);
          return {
            runGroupId: group.id!,
            runGroupArn: group.arn!,
            name: group.name ?? name,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* omics
            .deleteRunGroup({ id: output.runGroupId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
