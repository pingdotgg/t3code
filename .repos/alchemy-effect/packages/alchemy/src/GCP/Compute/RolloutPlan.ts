import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;
const DEFAULT_SCOPE: compute.RolloutPlanLocationScopeEnum = "ZONAL";

export type RolloutPlanLocationScope =
  | compute.RolloutPlanLocationScopeEnum
  | (string & {});
export type RolloutPlanWave = compute.RolloutPlanWave;

export type RolloutPlanProps = {
  /**
   * Rollout plan name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing the
   * name replaces the plan.
   */
  rolloutPlanName?: string;
  /**
   * Optional description. Compute rollout plans have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Location scope of the plan (`ZONAL` or `REGIONAL`). Immutable —
   * changing it replaces the plan.
   * @default "ZONAL"
   */
  locationScope?: RolloutPlanLocationScope;
  /**
   * Waves that divide the rollout. The Compute API has no update method
   * for rollout plans — changing waves replaces the plan.
   */
  waves?: ReadonlyArray<RolloutPlanWave>;
};

export type RolloutPlan = Resource<
  "GCP.Compute.RolloutPlan",
  RolloutPlanProps,
  {
    /** Rollout plan name. */
    rolloutPlanName: string;
    /** Server-assigned numeric id. */
    rolloutPlanId: string | undefined;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Location scope (`ZONAL` or `REGIONAL`). */
    locationScope: string | undefined;
    /** Waves in this plan. */
    waves: ReadonlyArray<RolloutPlanWave>;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-global Compute Engine rollout plan.
 *
 * Rollout plans divide a large change (for example a global VM extension
 * policy) into waves. Compute Engine has no labels and no update method on
 * this resource, so Alchemy stamps ownership into the description and
 * treats name, scope, description, and waves as replacement triggers.
 *
 * ### Creating a Rollout Plan
 * **Example:** Single-wave zonal plan
 * ```typescript
 * const plan = yield* GCP.Compute.RolloutPlan("Fleet", {
 *   waves: [
 *     {
 *       displayName: "central",
 *       selectors: [
 *         {
 *           locationSelector: {
 *             includedLocations: ["us-central1-a"],
 *           },
 *         },
 *       ],
 *       validation: {
 *         type: "time",
 *         timeBasedValidationMetadata: { waitDuration: "0s" },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Named plan with a description
 * ```typescript
 * const plan = yield* GCP.Compute.RolloutPlan("Fleet", {
 *   rolloutPlanName: "ops-agent-rollout",
 *   description: "ops-agent canary",
 *   locationScope: "ZONAL",
 *   waves: [
 *     {
 *       selectors: [
 *         {
 *           locationSelector: {
 *             includedLocations: ["us-central1-a", "us-central1-b"],
 *           },
 *         },
 *       ],
 *       validation: { type: "manual" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RolloutPlan = Resource<RolloutPlan>("GCP.Compute.RolloutPlan");

export class RolloutPlanNotResolved extends Data.TaggedError(
  "GCP.Compute.RolloutPlanNotResolved",
)<{
  rolloutPlanName: string;
}> {}

export class RolloutPlanStillExists extends Data.TaggedError(
  "GCP.Compute.RolloutPlanStillExists",
)<{
  rolloutPlanName: string;
}> {}

const defaultWaves = (): compute.RolloutPlanWave[] => [
  {
    displayName: "default",
    selectors: [
      {
        locationSelector: {
          includedLocations: ["us-central1-a"],
        },
      },
    ],
    validation: {
      type: "time",
      timeBasedValidationMetadata: { waitDuration: "0s" },
    },
  },
];

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `p${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const toBody = (
  rolloutPlanName: string,
  props: RolloutPlanProps,
  ownership: Record<string, string>,
): compute.RolloutPlan => ({
  name: rolloutPlanName,
  description: encodeDescription(ownership, props.description),
  locationScope: props.locationScope ?? DEFAULT_SCOPE,
  waves: [...(props.waves ?? defaultWaves())],
});

const toAttrs = (
  plan: compute.RolloutPlan,
  project: string,
): RolloutPlan["Attributes"] => {
  const parsed = parseDescription(plan.description);
  return {
    rolloutPlanName: plan.name ?? plan.id ?? "",
    rolloutPlanId: plan.id,
    project,
    description: parsed.description,
    locationScope: plan.locationScope,
    waves: plan.waves ?? [],
    selfLink: plan.selfLink,
    creationTimestamp: plan.creationTimestamp,
  };
};

const getByName = (project: string, rolloutPlan: string) =>
  compute
    .getRolloutPlans({ project, rolloutPlan })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitPlanGone = (project: string, rolloutPlanName: string) =>
  getByName(project, rolloutPlanName).pipe(
    Effect.flatMap((plan) =>
      plan === undefined
        ? Effect.void
        : Effect.fail(
            new RolloutPlanStillExists({
              rolloutPlanName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof RolloutPlanStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const RolloutPlanProvider = () =>
  Provider.succeed(RolloutPlan, {
    stables: [
      "rolloutPlanName",
      "rolloutPlanId",
      "project",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName = olds?.rolloutPlanName ?? output?.rolloutPlanName;
      const nextName = news.rolloutPlanName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousScope =
        olds?.locationScope ?? output?.locationScope ?? DEFAULT_SCOPE;
      const nextScope = news.locationScope ?? DEFAULT_SCOPE;
      const previousWaves = olds?.waves ?? output?.waves;
      const nextWaves = news.waves;
      const wavesChanged =
        nextWaves !== undefined &&
        previousWaves !== undefined &&
        !sameJson(previousWaves, nextWaves);
      const previousDescription = olds?.description ?? output?.description;
      const descriptionChanged =
        news.description !== undefined &&
        previousDescription !== undefined &&
        news.description !== previousDescription;

      if (nameChanged || previousScope !== nextScope || wavesChanged) {
        return {
          action: "replace" as const,
          deleteFirst: !nameChanged,
        };
      }
      if (descriptionChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const rolloutPlanName = yield* toName(
        id,
        olds?.rolloutPlanName,
        output?.rolloutPlanName,
      );
      const existing = yield* getByName(env.project, rolloutPlanName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listRolloutPlans
          .items({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((plan) => hasOwnershipMarker(plan.description)),
            Stream.map((plan) => toAttrs(plan, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const rolloutPlanName = yield* toName(
        id,
        news.rolloutPlanName,
        output?.rolloutPlanName,
      );
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(rolloutPlanName, news, ownership);

      let current = yield* getByName(env.project, rolloutPlanName);

      if (current === undefined) {
        const inserted = yield* compute
          .insertRolloutPlans({
            project: env.project,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitGlobalOperation(env.project, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* getByName(env.project, rolloutPlanName).pipe(
          Effect.filterOrFail(
            (plan): plan is compute.RolloutPlan => plan !== undefined,
            () => new RolloutPlanNotResolved({ rolloutPlanName }),
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.Compute.RolloutPlanNotResolved",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
        );
      }

      if (current === undefined) {
        return yield* new RolloutPlanNotResolved({ rolloutPlanName });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const deleted = yield* compute
        .deleteRolloutPlans({
          project,
          rolloutPlan: output.rolloutPlanName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (deleted !== undefined) {
        yield* waitGlobalOperation(project, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitPlanGone(project, output.rolloutPlanName);
    }),
  });
