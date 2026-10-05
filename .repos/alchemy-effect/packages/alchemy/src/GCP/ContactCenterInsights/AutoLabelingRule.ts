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
  encodeOwnership,
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type LabelingCondition = {
  /** CEL expression evaluated as the label value. */
  value?: string;
  /**
   * Optional CEL predicate. When true (or empty), `value` is used. The
   * first matching condition wins.
   */
  condition?: string;
};

export type AutoLabelingRuleProps = {
  /**
   * Auto-labeling rule id (the `{auto_labeling_rule}` segment of
   * `projects/{project}/locations/{location}/autoLabelingRules/{auto_labeling_rule}`).
   * If omitted, a unique id is generated. Immutable — changing it replaces
   * the rule. Also used as `labelKey` when `labelKeyType` is
   * `LABEL_KEY_TYPE_CUSTOM`.
   */
  autoLabelingRuleId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the rule.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Auto-labeling rules have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * When true, the rule is applied to conversations.
   * @default false
   */
  active?: boolean;
  /**
   * Label key written onto matching conversations. Defaults to
   * `autoLabelingRuleId`. Only settable when `labelKeyType` is
   * `LABEL_KEY_TYPE_CUSTOM`.
   */
  labelKey?: string;
  /**
   * Label key type.
   * @default "LABEL_KEY_TYPE_CUSTOM"
   */
  labelKeyType?:
    | "LABEL_KEY_TYPE_UNSPECIFIED"
    | "LABEL_KEY_TYPE_CUSTOM"
    | (string & {});
  /**
   * Sequential if / else-if conditions. The value of the first matching
   * condition is used.
   */
  conditions?: LabelingCondition[];
};

export type AutoLabelingRule = Resource<
  "GCP.ContactCenterInsights.AutoLabelingRule",
  AutoLabelingRuleProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/autoLabelingRules/{auto_labeling_rule}`. */
    name: string;
    /** Auto-labeling rule id (last path segment). */
    autoLabelingRuleId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the rule is active. */
    active: boolean;
    /** Label key. */
    labelKey: string | undefined;
    /** Label key type. */
    labelKeyType: string | undefined;
    /** Labeling conditions. */
    conditions: LabelingCondition[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights auto-labeling rule that writes a custom
 * label onto matching conversations.
 *
 * Auto-labeling rules have no labels field — Alchemy stamps ownership into
 * the description. Location and id are immutable. Display name,
 * description, active flag, and conditions update in place.
 *
 * ### Creating an Auto-Labeling Rule
 * **Example:** Inactive custom label
 * ```typescript
 * const rule = yield* GCP.ContactCenterInsights.AutoLabelingRule("Topic", {
 *   displayName: "billing-topic",
 *   active: false,
 *   conditions: [{ value: '"billing"', condition: "true" }],
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const AutoLabelingRule = Resource<AutoLabelingRule>(
  "GCP.ContactCenterInsights.AutoLabelingRule",
);

export class AutoLabelingRuleNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.AutoLabelingRuleNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_LABEL_KEY_TYPE = "LABEL_KEY_TYPE_CUSTOM";

const resourceName = (
  project: string,
  location: string,
  autoLabelingRuleId: string,
) =>
  `${locationParent(project, location)}/autoLabelingRules/${autoLabelingRuleId}`;

const conditionsOf = (
  list:
    | readonly cci.GoogleCloudContactcenterinsightsV1AutoLabelingRuleLabelingCondition[]
    | undefined,
): LabelingCondition[] =>
  (list ?? []).map((condition) => ({
    value: condition.value,
    condition: condition.condition,
  }));

const toAttrs = (
  rule: cci.GoogleCloudContactcenterinsightsV1AutoLabelingRule,
  project: string,
) => {
  const name = rule.name ?? "";
  const parsed = parseOwnership(rule.description);
  return {
    name,
    autoLabelingRuleId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: rule.displayName,
    description: parsed.text,
    active: rule.active === true,
    labelKey: rule.labelKey,
    labelKeyType: rule.labelKeyType,
    conditions: conditionsOf(rule.conditions),
    createTime: rule.createTime,
    updateTime: rule.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsAutoLabelingRules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsAutoLabelingRules
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.autoLabelingRules ?? []),
      ),
      Stream.filter((rule) => hasOwnershipMarker(rule.description)),
      Stream.map((rule) => toAttrs(rule, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const AutoLabelingRuleProvider = () =>
  Provider.succeed(AutoLabelingRule, {
    stables: [
      "name",
      "autoLabelingRuleId",
      "location",
      "project",
      "labelKey",
      "createTime",
    ],

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
      const previousId = olds?.autoLabelingRuleId ?? output?.autoLabelingRuleId;
      if (
        previousId !== undefined &&
        news.autoLabelingRuleId !== undefined &&
        news.autoLabelingRuleId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const autoLabelingRuleId = yield* toResourceId(
        id,
        olds?.autoLabelingRuleId,
        output?.autoLabelingRuleId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, autoLabelingRuleId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
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
      const autoLabelingRuleId = yield* toResourceId(
        id,
        news.autoLabelingRuleId,
        output?.autoLabelingRuleId,
      );
      const name = resourceName(env.project, location, autoLabelingRuleId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName =
        news.displayName ?? encodeOwnershipLine(ownership, undefined);
      const active = news.active === true;
      const labelKeyType = news.labelKeyType ?? DEFAULT_LABEL_KEY_TYPE;
      const labelKey = news.labelKey ?? autoLabelingRuleId;
      const conditions = news.conditions ?? [];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsAutoLabelingRules({
            parent,
            autoLabelingRuleId,
            body: {
              displayName,
              description,
              active,
              labelKey,
              labelKeyType,
              conditions,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AutoLabelingRuleNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const activeChanged = (current.active === true) !== active;
      const conditionsChanged = !jsonEqual(
        conditionsOf(current.conditions),
        conditions,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        activeChanged ||
        conditionsChanged
      ) {
        current = yield* cci.patchProjectsLocationsAutoLabelingRules({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            activeChanged ? "active" : undefined,
            conditionsChanged ? "conditions" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            description,
            active,
            conditions,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsAutoLabelingRules({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
