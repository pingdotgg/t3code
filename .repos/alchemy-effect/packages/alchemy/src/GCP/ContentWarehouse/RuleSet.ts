import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  LIST_LOCATIONS,
  collectPages,
  encodeOwnership,
  ensureProject,
  hasOwnershipMarker,
  ignoreList,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  waitUntilExists,
  waitUntilGone,
  ResourceNotResolved,
} from "./internal.ts";

export type Rule = cw.GoogleCloudContentwarehouseV1Rule;

export type RuleSetProps = {
  /**
   * Rule set id (the `{ruleSet}` segment of
   * `projects/{project}/locations/{location}/ruleSets/{ruleSet}`).
   * Assigned by the API on create. Immutable — changing it replaces the
   * rule set. Supply it to adopt an existing rule set.
   */
  ruleSetId?: string;
  /**
   * Multi-region location (`us` or `eu`). Immutable — changing it
   * replaces the rule set. `US` is accepted and normalized to `us`.
   * @default "us"
   */
  location?: string;
  /**
   * Short description. Rule sets have no labels field, so Alchemy stamps
   * ownership into a `[alchemy …]` prefix and strips it from attributes.
   */
  description?: string;
  /**
   * Source of the rules (customer name).
   */
  source?: string;
  /**
   * Rules evaluated on document create/update/link events.
   */
  rules?: Rule[];
};

export type RuleSet = Resource<
  "GCP.ContentWarehouse.RuleSet",
  RuleSetProps,
  {
    /** Full resource name. */
    name: string;
    /** Rule set id (last path segment). */
    ruleSetId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Source of the rules. */
    source: string | undefined;
    /** Rules in the set. */
    rules: Rule[] | undefined;
  },
  never,
  Providers
>;

const DEFAULT_RULES: Rule[] = [
  {
    description: "always",
    triggerType: "ON_CREATE",
    condition: "true",
    actions: [
      {
        dataValidation: {
          conditions: { display_name: "true" },
        },
      },
    ],
  },
];

/**
 * A Document AI Warehouse rule set — trigger conditions and actions run
 * when documents are created, updated, or linked.
 *
 * Rule sets have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Location is immutable.
 * Description, source, and rules update in place.
 *
 * ### Creating a Rule Set
 * **Example:** Validate on create
 * ```typescript
 * const rules = yield* GCP.ContentWarehouse.RuleSet("Checks", {
 *   source: "alchemy",
 *   rules: [
 *     {
 *       description: "require title",
 *       triggerType: "ON_CREATE",
 *       condition: "true",
 *       actions: [{ dataValidation: { conditions: { display_name: "true" } } }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ContentWarehouse
 */
export const RuleSet = Resource<RuleSet>("GCP.ContentWarehouse.RuleSet");

const resourceName = (project: string, location: string, ruleSetId: string) =>
  `${locationParent(project, location)}/ruleSets/${ruleSetId}`;

const toAttrs = (
  item: cw.GoogleCloudContentwarehouseV1RuleSet,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "ruleSets");
  return {
    name,
    ruleSetId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: parseOwnership(item.description).text,
    source: item.source,
    rules: item.rules,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cw
        .getProjectsLocationsRuleSets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  collectPages(
    cw.listProjectsLocationsRuleSets.pages({ parent, pageSize: 1000 }),
    (page) => page.ruleSets,
  ).pipe(ignoreList([] as cw.GoogleCloudContentwarehouseV1RuleSet[]));

const findOwned = (
  id: string,
  items: readonly cw.GoogleCloudContentwarehouseV1RuleSet[],
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.description)) return item;
    }
    return undefined as cw.GoogleCloudContentwarehouseV1RuleSet | undefined;
  });

const listOwned = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) => listAt(locationParent(project, location)),
    { concurrency: 2 },
  ).pipe(
    Effect.map((groups) =>
      groups.flat().filter((item) => hasOwnershipMarker(item.description)),
    ),
  );

export const RuleSetProvider = () =>
  Provider.succeed(RuleSet, {
    stables: ["name", "ruleSetId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.ruleSetId ?? output?.ruleSetId,
        nextId: news.ruleSetId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const ruleSetId = olds?.ruleSetId ?? output?.ruleSetId;
      const name =
        output?.name ??
        (ruleSetId ? resourceName(env.project, location, ruleSetId) : "");
      let existing = yield* getByName(name);
      if (existing === undefined) {
        const listed = yield* listAt(locationParent(env.project, location));
        existing = yield* findOwned(id, listed);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = locationParent(env.project, location);
      yield* ensureProject(parent);
      const ruleSetId = yield* toPhysicalId(
        id,
        news.ruleSetId,
        output?.ruleSetId,
        "rules",
      );
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const source = news.source ?? "alchemy";
      const rules = news.rules ?? DEFAULT_RULES;

      const findInParent = listAt(parent).pipe(
        Effect.flatMap((items) => findOwned(id, items)),
      );
      let current =
        (yield* getByName(output?.name ?? "")) ?? (yield* findInParent);

      if (current === undefined) {
        const created = yield* cw
          .createProjectsLocationsRuleSets({
            parent,
            body: { description, source, rules },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created ??
          (yield* findInParent) ??
          (yield* waitUntilExists(
            findInParent,
            resourceName(env.project, location, ruleSetId),
          ));
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: output?.name ?? resourceName(env.project, location, ruleSetId),
        });
      }

      const currentName = current.name ?? "";
      const descriptionChanged = !sameText(current.description, description);
      const sourceChanged = !sameText(current.source, source);
      const rulesChanged = !sameJson(current.rules, rules);
      if (descriptionChanged || sourceChanged || rulesChanged) {
        current = yield* cw.patchProjectsLocationsRuleSets({
          name: currentName,
          body: {
            ruleSet: {
              name: currentName,
              description,
              source,
              rules,
            },
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cw
        .deleteProjectsLocationsRuleSets({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
