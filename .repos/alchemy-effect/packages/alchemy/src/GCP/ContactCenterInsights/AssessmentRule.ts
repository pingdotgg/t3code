import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type ScheduleInfo = {
  /** Time zone used to interpret `schedule`. Defaults to UTC. */
  timeZone?: string;
  /** RFC3339 start. Omitted starts as soon as the rule is created. */
  startTime?: string;
  /** RFC3339 end. Omitted keeps scheduling until the rule is deleted. */
  endTime?: string;
  /**
   * Groc expression (e.g. `"every 5 minutes"` or
   * `"every 1 hours synchronized"`).
   */
  schedule?: string;
};

export type SampleRule = {
  /**
   * Group-by dimension. Currently
   * `quality_metadata.agent_info.agent_id` is supported. Empty samples
   * at the project level.
   */
  dimension?: string;
  /** Filter selecting conversations to sample. Empty applies to all. */
  conversationFilter?: string;
  /** Fraction of conversations to sample, in `[0, 1]`. */
  samplePercentage?: number;
  /** Absolute number of conversations to sample. */
  sampleRow?: string;
};

export type AssessmentRuleProps = {
  /**
   * Assessment rule id (the `{assessment_rule}` segment of
   * `projects/{project}/locations/{location}/assessmentRules/{assessment_rule}`).
   * If omitted, a unique id is generated. Must match `^[A-Za-z0-9]{4,64}$`
   * (no dashes). Immutable — changing it replaces the rule.
   */
  assessmentRuleId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the rule.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Assessment rules have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
  /**
   * When true, the rule is applied to sampled conversations.
   * @default false
   */
  active?: boolean;
  /** Sampling configuration. */
  sampleRule?: SampleRule;
  /** Schedule on which sampled conversations are assessed. */
  scheduleInfo?: ScheduleInfo;
};

export type AssessmentRule = Resource<
  "GCP.ContactCenterInsights.AssessmentRule",
  AssessmentRuleProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/assessmentRules/{assessment_rule}`. */
    name: string;
    /** Assessment rule id (last path segment). */
    assessmentRuleId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Whether the rule is active. */
    active: boolean;
    /** Sampling configuration. */
    sampleRule: SampleRule | undefined;
    /** Schedule configuration. */
    scheduleInfo: ScheduleInfo | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights assessment rule that samples conversations
 * on a schedule for quality assessment.
 *
 * Assessment rules have no labels field — Alchemy stamps ownership into
 * the display name. Location and id are immutable. Active flag, sample
 * rule, and schedule update in place.
 *
 * ### Creating an Assessment Rule
 * **Example:** Inactive hourly sample
 * ```typescript
 * const rule = yield* GCP.ContactCenterInsights.AssessmentRule("Qa", {
 *   displayName: "hourly-qa",
 *   active: false,
 *   sampleRule: { samplePercentage: 0.1 },
 *   scheduleInfo: { schedule: "every 1 hours", timeZone: "UTC" },
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const AssessmentRule = Resource<AssessmentRule>(
  "GCP.ContactCenterInsights.AssessmentRule",
);

export class AssessmentRuleNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.AssessmentRuleNotResolved",
)<{
  name: string;
}> {}

// Assessment rule ids allow only `[A-Za-z0-9]{4,64}`, unlike the dashed
// ids `toResourceId` generates.
const toAssessmentRuleId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  requested !== undefined || existing !== undefined
    ? toResourceId(id, requested, existing)
    : toResourceId(id, undefined, undefined).pipe(
        Effect.map((generated) => generated.replace(/[^a-z0-9]/g, "")),
      );

const resourceName = (
  project: string,
  location: string,
  assessmentRuleId: string,
) => `${locationParent(project, location)}/assessmentRules/${assessmentRuleId}`;

const sampleOf = (
  sample: cci.GoogleCloudContactcenterinsightsV1SampleRule | undefined,
): SampleRule | undefined => {
  if (sample === undefined) return undefined;
  return {
    dimension: sample.dimension,
    conversationFilter: sample.conversationFilter,
    samplePercentage: sample.samplePercentage,
    sampleRow: sample.sampleRow,
  };
};

const scheduleOf = (
  schedule: cci.GoogleCloudContactcenterinsightsV1ScheduleInfo | undefined,
): ScheduleInfo | undefined => {
  if (schedule === undefined) return undefined;
  return {
    timeZone: schedule.timeZone,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    schedule: schedule.schedule,
  };
};

const toAttrs = (
  rule: cci.GoogleCloudContactcenterinsightsV1AssessmentRule,
  project: string,
) => {
  const name = rule.name ?? "";
  const parsed = parseOwnership(rule.displayName);
  return {
    name,
    assessmentRuleId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    active: rule.active === true,
    sampleRule: sampleOf(rule.sampleRule),
    scheduleInfo: scheduleOf(rule.scheduleInfo),
    createTime: rule.createTime,
    updateTime: rule.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsAssessmentRules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsAssessmentRules
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.assessmentRules ?? [])),
      Stream.filter((rule) => hasOwnershipMarker(rule.displayName)),
      Stream.map((rule) => toAttrs(rule, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

/** Assessment rules reject display names over 64 characters ("Request contains an invalid argument"). */
const MAX_RULE_DISPLAY_NAME = 64;

export const AssessmentRuleProvider = () =>
  Provider.succeed(AssessmentRule, {
    stables: ["name", "assessmentRuleId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.assessmentRuleId ?? output?.assessmentRuleId;
      if (
        previousId !== undefined &&
        news.assessmentRuleId !== undefined &&
        news.assessmentRuleId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const assessmentRuleId = yield* toAssessmentRuleId(
        id,
        olds?.assessmentRuleId,
        output?.assessmentRuleId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, assessmentRuleId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = locationParent(env.project, location);
      const assessmentRuleId = yield* toAssessmentRuleId(
        id,
        news.assessmentRuleId,
        output?.assessmentRuleId,
      );
      const name = resourceName(env.project, location, assessmentRuleId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_RULE_DISPLAY_NAME,
      );
      const active = news.active === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsAssessmentRules({
            parent,
            assessmentRuleId,
            body: {
              displayName,
              active,
              sampleRule: news.sampleRule,
              scheduleInfo: news.scheduleInfo,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AssessmentRuleNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const activeChanged = (current.active === true) !== active;
      const sampleChanged = !jsonEqual(
        sampleOf(current.sampleRule),
        news.sampleRule,
      );
      const scheduleChanged = !jsonEqual(
        scheduleOf(current.scheduleInfo),
        news.scheduleInfo,
      );

      if (displayChanged || activeChanged || sampleChanged || scheduleChanged) {
        current = yield* cci.patchProjectsLocationsAssessmentRules({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            activeChanged ? "active" : undefined,
            sampleChanged ? "sample_rule" : undefined,
            scheduleChanged ? "schedule_info" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            active,
            sampleRule: news.sampleRule,
            scheduleInfo: news.scheduleInfo,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsAssessmentRules({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
