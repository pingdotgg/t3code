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
  lastSegment,
  MAX_SESSION_ID_LENGTH,
  parseResourceName,
  sameJson,
  sameText,
  toResourceId,
  retryQuota,
} from "./internal.ts";

export type SessionEntity = {
  /** Canonical entity value. */
  value: string;
  /** Synonyms that map onto `value`. */
  synonyms?: string[];
};

export type AgentsEnvironmentsSessionsEntityTypeProps = {
  /**
   * Parent environment resource name
   * `projects/{project}/locations/{location}/agents/{agent}/environments/{environment}`.
   * Immutable — changing it replaces the session entity type.
   */
  environment: string;
  /**
   * Entity type resource name or id. Immutable — changing it replaces
   * the session entity type.
   */
  entityType: string;
  /**
   * Session id (at most 36 bytes). If omitted, a unique id is generated.
   * Immutable — changing it replaces the session entity type.
   */
  sessionId?: string;
  /**
   * How session entities interact with the custom entity type.
   * @default "ENTITY_OVERRIDE_MODE_OVERRIDE"
   */
  entityOverrideMode?:
    | "ENTITY_OVERRIDE_MODE_UNSPECIFIED"
    | "ENTITY_OVERRIDE_MODE_OVERRIDE"
    | "ENTITY_OVERRIDE_MODE_SUPPLEMENT"
    | (string & {});
  /** Session-scoped entity values. */
  entities: SessionEntity[];
};

export type AgentsEnvironmentsSessionsEntityType = Resource<
  "GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType",
  AgentsEnvironmentsSessionsEntityTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Entity type id (last path segment). */
    entityTypeId: string;
    /** Parent environment resource name. */
    environment: string;
    /** Session resource name. */
    session: string;
    /** Session id. */
    sessionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Override mode. */
    entityOverrideMode: string | undefined;
    /** Session-scoped entity values. */
    entities: SessionEntity[];
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX session entity type under an environment session.
 *
 * Session entity types have no labels or description field; Alchemy
 * identifies one by environment, session id, and entity type. Without
 * state, one found under an explicit `sessionId` is reported as unowned.
 * Parent environment, session id, and entity type are immutable.
 * Override mode and entities update in place.
 *
 * ### Creating a Session Entity Type
 * **Example:** Override a color entity for one session
 * ```typescript
 * const session = yield* GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType(
 *   "SessionColor",
 *   {
 *     environment: environment.name,
 *     entityType: color.name,
 *     entityOverrideMode: "ENTITY_OVERRIDE_MODE_OVERRIDE",
 *     entities: [{ value: "blue", synonyms: ["blue", "navy"] }],
 *   },
 * );
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsEnvironmentsSessionsEntityType =
  Resource<AgentsEnvironmentsSessionsEntityType>(
    "GCP.Dialogflow.AgentsEnvironmentsSessionsEntityType",
  );

export class AgentsEnvironmentsSessionsEntityTypeNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsEnvironmentsSessionsEntityTypeNotResolved",
)<{
  name: string;
}> {}

// Earlier versions stamped a `__alchemy__…` sentinel entity; drop it.
const LEGACY_SENTINEL_PREFIX = "__alchemy__";

const entitiesOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntity[]
    | undefined,
): SessionEntity[] =>
  (list ?? [])
    .filter((entity) => (entity.value ?? "").length > 0)
    .filter(
      (entity) => !(entity.value ?? "").startsWith(LEGACY_SENTINEL_PREFIX),
    )
    .map((entity) => ({
      value: entity.value ?? "",
      synonyms: [...(entity.synonyms ?? [])],
    }));

const hasLegacySentinel = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntity[]
    | undefined,
) =>
  (list ?? []).some((entity) =>
    (entity.value ?? "").startsWith(LEGACY_SENTINEL_PREFIX),
  );

const toAttrs = (
  sessionEntityType: dialogflow.GoogleCloudDialogflowCxV3SessionEntityType,
  project: string,
) => {
  const name = sessionEntityType.name ?? "";
  const parsed = parseResourceName(name, "entityTypes");
  return {
    name,
    entityTypeId: parsed.id,
    environment: parsed.environment,
    session: parsed.session,
    sessionId: parsed.sessionId,
    project: parsed.project || project,
    location: parsed.location,
    entityOverrideMode: sessionEntityType.entityOverrideMode,
    entities: entitiesOf(sessionEntityType.entities),
  };
};

const resourceNameOf = (
  environment: string,
  sessionId: string,
  entityTypeId: string,
) => `${environment}/sessions/${sessionId}/entityTypes/${entityTypeId}`;

const entityTypeIdOf = (entityType: string) => lastSegment(entityType);

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const AgentsEnvironmentsSessionsEntityTypeProvider = () =>
  Provider.succeed(AgentsEnvironmentsSessionsEntityType, {
    stables: [
      "name",
      "entityTypeId",
      "environment",
      "session",
      "sessionId",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.environment ?? output?.environment;
      const previousSession = olds?.sessionId ?? output?.sessionId;
      const previousType = lastSegment(
        olds?.entityType ?? output?.entityTypeId ?? "",
      );
      const nextType = lastSegment(news.entityType);
      if (
        (previousParent !== undefined && news.environment !== previousParent) ||
        (previousSession !== undefined &&
          news.sessionId !== undefined &&
          news.sessionId !== previousSession) ||
        (previousType.length > 0 && nextType !== previousType)
      ) {
        return {
          action: "replace" as const,
          deleteFirst: false,
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
      const generated = yield* toResourceId(
        id,
        undefined,
        undefined,
        MAX_SESSION_ID_LENGTH,
      );
      const sessionId = olds.sessionId ?? generated;
      const found = yield* getByName(
        resourceNameOf(
          olds.environment,
          sessionId,
          entityTypeIdOf(olds.entityType),
        ),
      );
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      // A generated session id is unique to this stack, stage and id.
      return sessionId === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const environment = news.environment;
      const entityTypeId = entityTypeIdOf(news.entityType);
      const sessionId = yield* toResourceId(
        id,
        news.sessionId,
        output?.sessionId,
        MAX_SESSION_ID_LENGTH,
      );
      const name = resourceNameOf(environment, sessionId, entityTypeId);
      const entityOverrideMode =
        news.entityOverrideMode ?? "ENTITY_OVERRIDE_MODE_OVERRIDE";
      const entities = news.entities.map((entity) => ({
        value: entity.value,
        synonyms: entity.synonyms,
      }));
      const body: dialogflow.GoogleCloudDialogflowCxV3SessionEntityType = {
        name,
        entityOverrideMode,
        entities,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({
            parent: `${environment}/sessions/${sessionId}`,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsEnvironmentsSessionsEntityTypeNotResolved({
          name,
        });
      }

      const currentName = current.name ?? name;
      const modeChanged = !sameText(
        current.entityOverrideMode,
        entityOverrideMode,
      );
      const entitiesChanged = !sameJson(
        entitiesOf(current.entities),
        entitiesOf(news.entities),
      );
      const legacySentinel = hasLegacySentinel(current.entities);

      if (modeChanged || entitiesChanged || legacySentinel) {
        current =
          yield* dialogflow.patchProjectsLocationsAgentsEnvironmentsSessionsEntityTypes(
            {
              // An `entities` update mask is silently ignored; the body is
              // complete, so replace the whole resource.
              name: currentName,
              body: { ...body, name: currentName },
            },
          );
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsEnvironmentsSessionsEntityTypes({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
