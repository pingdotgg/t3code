import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  expandName,
  hasOwnershipMarker,
  listEntityTypes,
  normalizeLocation,
  parseResourceName,
  sameJson,
  sameText,
  updateMaskOf,
  retryQuota,
  toResourceId,
} from "./internal.ts";

export type EntityTypeKind =
  | "KIND_UNSPECIFIED"
  | "KIND_MAP"
  | "KIND_LIST"
  | "KIND_REGEXP"
  | (string & {});

export type EntityTypeEntity = {
  /** Canonical entity value. */
  value: string;
  /** Synonyms that map onto `value`. */
  synonyms?: string[];
};

export type AgentsEntityTypeProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`. Immutable —
   * changing it replaces the entity type.
   */
  agent: string;
  /**
   * Entity type id (the `{entity_type}` segment). Server-assigned on
   * create. Immutable — changing it replaces the entity type.
   */
  entityTypeId?: string;
  /**
   * Location used when `agent` is a bare id.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name, unique within the agent (`[A-Za-z0-9_-]`).
   * Intents reference the type by it (`@color`). Entity types have no
   * labels, so without state Alchemy finds the entity type by this name.
   * @default a unique name generated from the stack, stage, and logical id
   */
  displayName?: string;
  /**
   * Entity kind.
   * @default "KIND_MAP"
   */
  kind?: EntityTypeKind;
  /** Canonical values and synonyms. Required for `KIND_MAP`. */
  entities?: EntityTypeEntity[];
  /** Phrases excluded from classification. */
  excludedPhrases?: Array<{ value: string }>;
  /**
   * Auto-expansion mode.
   * @default "AUTO_EXPANSION_MODE_UNSPECIFIED"
   */
  autoExpansionMode?:
    | "AUTO_EXPANSION_MODE_UNSPECIFIED"
    | "AUTO_EXPANSION_MODE_DEFAULT"
    | (string & {});
  /**
   * Enable fuzzy extraction.
   * @default false
   */
  enableFuzzyExtraction?: boolean;
  /**
   * Redact entity values in logs.
   * @default false
   */
  redact?: boolean;
  /** Language code of the entity type. */
  languageCode?: string;
};

export type AgentsEntityType = Resource<
  "GCP.Dialogflow.AgentsEntityType",
  AgentsEntityTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Entity type id (last path segment). */
    entityTypeId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Entity kind. */
    kind: string | undefined;
    /** Canonical values and synonyms. */
    entities: EntityTypeEntity[];
    /** Excluded phrases. */
    excludedPhrases: Array<{ value: string }>;
    /** Auto-expansion mode. */
    autoExpansionMode: string | undefined;
    /** Whether fuzzy extraction is enabled. */
    enableFuzzyExtraction: boolean;
    /** Whether values are redacted in logs. */
    redact: boolean;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX entity type under an agent.
 *
 * Entity types have no labels field, so Alchemy tracks an entity type by
 * its resource name; without state it is found by `displayName` (unique
 * within the agent) and reported as unowned unless that name is the
 * generated one. Parent agent and entity type id are
 * immutable. Display name, kind, entities, and extraction flags update
 * in place.
 *
 * ### Creating an Entity Type
 * **Example:** Map entity type
 * ```typescript
 * const color = yield* GCP.Dialogflow.AgentsEntityType("Color", {
 *   agent: agent.name,
 *   displayName: "color",
 *   kind: "KIND_MAP",
 *   entities: [{ value: "red", synonyms: ["red", "scarlet"] }],
 * });
 * ```
 *
 * ### Updating an Entity Type
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Add a synonym
 * ```typescript
 * const color = yield* GCP.Dialogflow.AgentsEntityType("Color", {
 *   agent: agent.name,
 *   displayName: "color",
 *   kind: "KIND_MAP",
 *   entities: [
 *     { value: "red", synonyms: ["red", "scarlet", "crimson"] },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsEntityType = Resource<AgentsEntityType>(
  "GCP.Dialogflow.AgentsEntityType",
);

export class AgentsEntityTypeNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsEntityTypeNotResolved",
)<{
  name: string;
}> {}

const entitiesOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntity[]
    | undefined,
): EntityTypeEntity[] =>
  (list ?? [])
    .filter((entity) => (entity.value ?? "").length > 0)
    .map((entity) => ({
      value: entity.value ?? "",
      synonyms: [...(entity.synonyms ?? [])],
    }));

const excludedOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeExcludedPhrase[]
    | undefined,
): Array<{ value: string }> =>
  (list ?? [])
    .filter((phrase) => (phrase.value ?? "").length > 0)
    .map((phrase) => ({ value: phrase.value ?? "" }));

// Drops the `[alchemy …]` excluded phrase earlier versions stamped.
const userExcludedOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeExcludedPhrase[]
    | undefined,
) => excludedOf(list).filter((phrase) => !hasOwnershipMarker(phrase.value));

const toAttrs = (
  entityType: dialogflow.GoogleCloudDialogflowCxV3EntityType,
  project: string,
) => {
  const name = entityType.name ?? "";
  const parsed = parseResourceName(name, "entityTypes");
  return {
    name,
    entityTypeId: parsed.id,
    agent: parsed.agent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: entityType.displayName,
    kind: entityType.kind,
    entities: entitiesOf(entityType.entities),
    excludedPhrases: userExcludedOf(entityType.excludedPhrases),
    autoExpansionMode: entityType.autoExpansionMode,
    enableFuzzyExtraction: entityType.enableFuzzyExtraction === true,
    redact: entityType.redact === true,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsEntityTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findByDisplayName = (agent: string, displayName: string) =>
  listEntityTypes(agent).pipe(
    Effect.map((entityTypes) =>
      entityTypes.find((entityType) => entityType.displayName === displayName),
    ),
  );

const displayNameOf = (id: string, requested: string | undefined) =>
  toResourceId(id, requested, undefined);

export const AgentsEntityTypeProvider = () =>
  Provider.succeed(AgentsEntityType, {
    stables: ["name", "entityTypeId", "agent", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      const previousId = olds?.entityTypeId ?? output?.entityTypeId;
      if (
        (previousAgent !== undefined && news.agent !== previousAgent) ||
        (previousId !== undefined &&
          news.entityTypeId !== undefined &&
          news.entityTypeId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousAgent === news.agent &&
            previousId !== undefined &&
            news.entityTypeId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (output?.name !== undefined) {
        const existing = yield* getByName(output.name);
        return existing === undefined
          ? undefined
          : toAttrs(existing, env.project);
      }
      if (olds === undefined) return undefined;
      const generated = yield* displayNameOf(id, undefined);
      const displayName = olds.displayName ?? generated;
      const agent = expandName(
        olds.agent,
        env.project,
        normalizeLocation(olds.location),
        "agents",
      );
      const found = yield* findByDisplayName(agent, displayName);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      // A generated display name is unique to this stack, stage and id.
      return displayName === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const agent = expandName(news.agent, env.project, location, "agents");
      const displayName = yield* displayNameOf(id, news.displayName);
      const kind = news.kind ?? "KIND_MAP";
      const entities = news.entities;
      const excludedPhrases = news.excludedPhrases ?? [];
      const autoExpansionMode = news.autoExpansionMode;
      const enableFuzzyExtraction = news.enableFuzzyExtraction === true;
      const redact = news.redact === true;
      const body: dialogflow.GoogleCloudDialogflowCxV3EntityType = {
        displayName,
        kind,
        entities,
        excludedPhrases,
        autoExpansionMode,
        enableFuzzyExtraction,
        redact,
      };

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findByDisplayName(agent, displayName));

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsEntityTypes({
            parent: agent,
            languageCode: news.languageCode,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(agent, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        const name =
          output?.name ??
          (news.entityTypeId
            ? `${agent}/entityTypes/${news.entityTypeId}`
            : agent);
        return yield* new AgentsEntityTypeNotResolved({ name });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const kindChanged = !sameText(current.kind, kind);
      const entitiesChanged = !sameJson(
        entitiesOf(current.entities),
        entitiesOf(entities),
      );
      const excludedChanged = !sameJson(
        excludedOf(current.excludedPhrases),
        excludedOf(excludedPhrases),
      );
      const expansionChanged = !sameText(
        current.autoExpansionMode,
        autoExpansionMode,
      );
      const fuzzyChanged =
        (current.enableFuzzyExtraction === true) !== enableFuzzyExtraction;
      const redactChanged = (current.redact === true) !== redact;

      if (
        displayChanged ||
        kindChanged ||
        entitiesChanged ||
        excludedChanged ||
        expansionChanged ||
        fuzzyChanged ||
        redactChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsAgentsEntityTypes({
          name: currentName,
          languageCode: news.languageCode,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            kindChanged ? "kind" : undefined,
            entitiesChanged ? "entities" : undefined,
            excludedChanged ? "excluded_phrases" : undefined,
            expansionChanged ? "auto_expansion_mode" : undefined,
            fuzzyChanged ? "enable_fuzzy_extraction" : undefined,
            redactChanged ? "redact" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsEntityTypes({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
