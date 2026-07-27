import * as deadline from "@distilled.cloud/aws/deadline";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, type Tags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  asPlain,
  deadlineArnOf,
  fetchDeadlineTags,
  reapDeadlineLogGroups,
  reapFarmChildren,
  retryWhileConflict,
  syncDeadlineTags,
} from "./internal.ts";

export interface FarmProps {
  /**
   * Display name of the farm.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * A description of the farm.
   */
  description?: string;
  /**
   * ARN of the KMS key used to encrypt farm data. Changing it replaces the
   * farm.
   * @default an AWS-owned key
   */
  kmsKeyArn?: string;
  /**
   * Multiplier applied to the cost of renders on this farm when computing
   * budget usage.
   * @default 1
   */
  costScaleFactor?: number;
  /**
   * Tags to associate with the farm.
   */
  tags?: Record<string, string>;
}

export interface Farm extends Resource<
  "AWS.Deadline.Farm",
  FarmProps,
  {
    /**
     * Service-assigned unique identifier of the farm (`farm-...`).
     */
    farmId: string;
    /**
     * ARN of the farm.
     */
    farmArn: string;
    /**
     * The farm's display name.
     */
    displayName: string;
    /**
     * ARN of the KMS key encrypting farm data, when customer-managed.
     */
    kmsKeyArn: string | undefined;
    /**
     * The configured cost scale factor.
     */
    costScaleFactor: number;
    /**
     * Current tags reported for the farm.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Deadline Cloud farm — the top-level container for render-farm
 * queues, fleets, storage profiles, and budgets.
 *
 * @resource
 * @section Creating Farms
 * @example Basic Farm
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const farm = yield* AWS.Deadline.Farm("RenderFarm", {});
 * ```
 *
 * @example Farm with Description and Cost Scaling
 * ```typescript
 * const farm = yield* AWS.Deadline.Farm("RenderFarm", {
 *   displayName: "studio-renders",
 *   description: "Production render farm",
 *   costScaleFactor: 1.5,
 *   tags: { team: "vfx" },
 * });
 * ```
 */
export const Farm = Resource<Farm>("AWS.Deadline.Farm");

const createFarmName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

interface FarmState {
  attrs: Farm["Attributes"];
  described: deadline.GetFarmResponse;
}

const readFarmById = Effect.fn(function* (
  farmId: string,
  arnOf: (path: string) => string,
) {
  const described = yield* deadline
    .getFarm({ farmId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described) return undefined;
  const farmArn = arnOf(`farm/${described.farmId}`);
  const state: FarmState = {
    described,
    attrs: {
      farmId: described.farmId,
      farmArn,
      displayName: described.displayName,
      kmsKeyArn: described.kmsKeyArn,
      costScaleFactor: described.costScaleFactor,
      tags: yield* fetchDeadlineTags(farmArn),
    },
  };
  return state;
});

const findFarmByDisplayName = Effect.fn(function* (
  displayName: string,
  arnOf: (path: string) => string,
) {
  const summaries = yield* deadline.listFarms.items({}).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  const match = summaries.find(
    (summary) => summary.displayName === displayName,
  );
  if (!match) return undefined;
  return yield* readFarmById(match.farmId, arnOf);
});

export const FarmProvider = () =>
  Provider.effect(
    Farm,
    Effect.gen(function* () {
      return {
        stables: ["farmId", "farmArn"],
        list: () =>
          Effect.gen(function* () {
            const arnOf = yield* deadlineArnOf;
            const summaries = yield* deadline.listFarms.items({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const states = yield* Effect.forEach(
              summaries,
              (summary) => readFarmById(summary.farmId, arnOf),
              { concurrency: 4 },
            );
            return states
              .filter((state): state is FarmState => state !== undefined)
              .map((state) => state.attrs);
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arnOf = yield* deadlineArnOf;
          const state = output?.farmId
            ? yield* readFarmById(output.farmId, arnOf)
            : yield* findFarmByDisplayName(
                yield* createFarmName(id, olds ?? {}),
                arnOf,
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The KMS key is fixed at creation.
          if ((olds.kmsKeyArn ?? undefined) !== (news.kmsKeyArn ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (news === undefined) {
            return yield* Effect.fail(
              new Error("AWS.Deadline.Farm requires props"),
            );
          }
          const arnOf = yield* deadlineArnOf;
          const displayName = yield* createFarmName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached farmId; fall back to a display-name
          // lookup so a create whose state failed to persist is adopted.
          let state = output?.farmId
            ? yield* readFarmById(output.farmId, arnOf)
            : yield* findFarmByDisplayName(displayName, arnOf);

          // Ensure — create if missing.
          if (state === undefined) {
            const created = yield* deadline.createFarm({
              displayName,
              description: news.description,
              kmsKeyArn: news.kmsKeyArn,
              costScaleFactor: news.costScaleFactor,
              tags: desiredTags,
            });
            yield* session.note(
              `Created farm ${displayName} (${created.farmId})`,
            );
            state = yield* readFarmById(created.farmId, arnOf);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created farm ${displayName}`),
              );
            }
          }

          // Sync mutable settings — only when drifted from OBSERVED state.
          const described = state.described;
          const needsUpdate =
            displayName !== described.displayName ||
            (news.description !== undefined &&
              news.description !== (asPlain(described.description) ?? "")) ||
            (news.costScaleFactor !== undefined &&
              news.costScaleFactor !== described.costScaleFactor);
          if (needsUpdate) {
            yield* deadline.updateFarm({
              farmId: state.attrs.farmId,
              displayName,
              description: news.description,
              costScaleFactor: news.costScaleFactor,
            });
            yield* session.note(`Updated farm ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          yield* syncDeadlineTags(state.attrs.farmArn, desiredTags);

          yield* session.note(state.attrs.farmArn);
          const final = yield* readFarmById(state.attrs.farmId, arnOf);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled farm ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          // A farm refuses deletion while ANY child resource exists (storage
          // profiles, queues, fleets, budgets, limits, associations) — and
          // unlike async sub-resource drain, those conflicts never resolve
          // by waiting. A normal stack destroy deletes children first, so
          // this reap observes nothing; an orphan sweep (nuke) or a mid-run
          // crash targets a farm whose children were never enumerated, and
          // without the reap deleteFarm conflicts until the retry budget
          // runs out and the farm leaks.
          yield* reapFarmChildren(output.farmId);
          // Child deletion (queues, fleets) finishes asynchronously; the
          // farm rejects deletion with ConflictException until it settles.
          yield* retryWhileConflict(
            deadline.deleteFarm({ farmId: output.farmId }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Deadline auto-creates log groups under /aws/deadline/{farmId}/
          // (queue job/session logs, fleet worker logs) and deleteFarm does
          // NOT remove them. The farm only deletes once every sub-resource
          // is fully gone, so by this point all of its log groups exist if
          // they ever will — sweep the whole prefix.
          yield* reapDeadlineLogGroups(`/aws/deadline/${output.farmId}`);
        }),
      };
    }),
  );
