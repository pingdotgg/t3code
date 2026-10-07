import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectionParent,
  DEFAULT_LOCATION,
  DEFAULT_SESSION,
  encodeOwnershipLine,
  expandAgent,
  fingerprint,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  locationOf,
  namedAgents,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  projectOf,
  retryQuota,
} from "./internal.ts";

export type SessionEntityOverrideMode =
  | "ENTITY_OVERRIDE_MODE_UNSPECIFIED"
  | "ENTITY_OVERRIDE_MODE_OVERRIDE"
  | "ENTITY_OVERRIDE_MODE_SUPPLEMENT";

export type AgentsSessionsEntity = {
  /** Canonical entity value. */
  value?: string;
  /** Synonyms that resolve to `value`. */
  synonyms?: string[];
};

export type AgentsSessionsEntityTypeProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`.
   * Immutable — changing it replaces the session entity type.
   */
  agent: string;
  /**
   * Session id. Dialogflow sessions are created implicitly.
   * Immutable — changing it replaces the session entity type.
   * @default "alchemy"
   */
  sessionId?: string;
  /**
   * Entity type id (`sys.color` or a custom entity type id). Immutable —
   * changing it replaces the session entity type.
   * @default "sys.color"
   */
  entityTypeId?: string;
  /**
   * Location used when `agent` is an id rather than a resource name.
   * Immutable — changing it replaces the session entity type.
   * @default "global"
   */
  location?: string;
  /**
   * How session entities combine with the backing entity type.
   * @default "ENTITY_OVERRIDE_MODE_OVERRIDE"
   */
  entityOverrideMode?: SessionEntityOverrideMode | (string & {});
  /**
   * Session entities. Alchemy stamps ownership into a reserved entity
   * value so `list` / nuke can find the resource (session entity types
   * have no labels or display name).
   */
  entities?: AgentsSessionsEntity[];
};

export type AgentsSessionsEntityType = Resource<
  "GCP.Dialogflow.AgentsSessionsEntityType",
  AgentsSessionsEntityTypeProps,
  {
    /** Full resource name `.../sessions/{session}/entityTypes/{entityType}`. */
    name: string;
    /** Entity type id (last path segment). */
    entityTypeId: string;
    /** Session id. */
    sessionId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Override mode. */
    entityOverrideMode: string | undefined;
    /** User entities with the Alchemy ownership entity stripped. */
    entities: AgentsSessionsEntity[];
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX session entity type (per-session entity overlay).
 *
 * Session entity types have no labels or display name — Alchemy stamps
 * ownership into a reserved entity value so `list` / nuke can find
 * them. `list` enumerates the default `alchemy` session on every agent.
 * Parent agent, session id, and entity type id are immutable. Override
 * mode and entities update in place.
 *
 * ### Creating a Session Entity Type
 * **Example:** Override `sys.color`
 * ```typescript
 * const overlay = yield* GCP.Dialogflow.AgentsSessionsEntityType("Colors", {
 *   agent: agentName,
 *   entityTypeId: "sys.color",
 *   entities: [{ value: "cerulean", synonyms: ["cerulean", "blue-green"] }],
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsSessionsEntityType = Resource<AgentsSessionsEntityType>(
  "GCP.Dialogflow.AgentsSessionsEntityType",
);

export class AgentsSessionsEntityTypeNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsSessionsEntityTypeNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_ENTITY_TYPE = "sys.color";
const DEFAULT_MODE: SessionEntityOverrideMode = "ENTITY_OVERRIDE_MODE_OVERRIDE";

const sessionParent = (agent: string, sessionId: string) =>
  `${agent}/sessions/${sessionId}`;

const resourceName = (agent: string, sessionId: string, entityTypeId: string) =>
  `${sessionParent(agent, sessionId)}/entityTypes/${entityTypeId}`;

const userEntities = (
  entities:
    | dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntityList
    | undefined,
): AgentsSessionsEntity[] =>
  (entities ?? [])
    .filter((entity) => !hasOwnershipMarker(entity.value))
    .map((entity) => ({
      value: entity.value,
      synonyms: entity.synonyms ? [...entity.synonyms] : undefined,
    }));

const stampEntities = (
  ownership: Record<string, string>,
  entities: AgentsSessionsEntity[] | undefined,
): dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntityList => {
  const marker = encodeOwnershipLine(ownership, undefined);
  return [
    { value: marker, synonyms: [marker] },
    ...(entities ?? []).filter((entity) => !hasOwnershipMarker(entity.value)),
  ];
};

const ownershipText = (
  entities:
    | dialogflow.GoogleCloudDialogflowCxV3EntityTypeEntityList
    | undefined,
) => entities?.find((entity) => hasOwnershipMarker(entity.value))?.value;

const toAttrs = (
  entityType: dialogflow.GoogleCloudDialogflowCxV3SessionEntityType,
  project: string,
  agentHint?: string,
) => {
  const name = entityType.name ?? "";
  const session = collectionParent(name, "sessions");
  return {
    name,
    entityTypeId: lastSegment(name),
    sessionId: lastSegment(session),
    agent: name.includes("/sessions/")
      ? collectionParent(name, "agents")
      : (agentHint ?? parentOf(parentOf(name))),
    location: locationOf(name),
    project: projectOf(name) || project,
    entityOverrideMode: entityType.entityOverrideMode,
    entities: userEntities(entityType.entities),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsSessionsEntityTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, agent: string) =>
  dialogflow.listProjectsLocationsAgentsSessionsEntityTypes
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.sessionEntityTypes ?? []),
      ),
      Stream.filter((entityType) =>
        (entityType.entities ?? []).some((entity) =>
          hasOwnershipMarker(entity.value),
        ),
      ),
      Stream.map((entityType) => toAttrs(entityType, project, agent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const AgentsSessionsEntityTypeProvider = () =>
  Provider.succeed(AgentsSessionsEntityType, {
    stables: [
      "name",
      "entityTypeId",
      "sessionId",
      "agent",
      "location",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      if (previousAgent !== undefined && news.agent !== previousAgent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousSession = olds?.sessionId ?? output?.sessionId;
      const nextSession = news.sessionId ?? DEFAULT_SESSION;
      if (previousSession !== undefined && previousSession !== nextSession) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousType = olds?.entityTypeId ?? output?.entityTypeId;
      const nextType = news.entityTypeId ?? DEFAULT_ENTITY_TYPE;
      if (previousType !== undefined && previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const agent = olds?.agent
        ? expandAgent(olds.agent, env.project, location)
        : output?.agent;
      const sessionId = olds?.sessionId ?? output?.sessionId ?? DEFAULT_SESSION;
      const entityTypeId =
        olds?.entityTypeId ?? output?.entityTypeId ?? DEFAULT_ENTITY_TYPE;
      const name =
        output?.name ??
        (agent !== undefined
          ? resourceName(agent, sessionId, entityTypeId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, agent);
      return (yield* ownedByAlchemy(id, ownershipText(existing.entities)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* namedAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) =>
            listAt(
              sessionParent(agent.name, DEFAULT_SESSION),
              env.project,
              agent.name,
            ),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const agent = expandAgent(news.agent, env.project, location);
      const sessionId = news.sessionId ?? output?.sessionId ?? DEFAULT_SESSION;
      const entityTypeId = lastSegment(
        news.entityTypeId ?? output?.entityTypeId ?? DEFAULT_ENTITY_TYPE,
      );
      const parent = sessionParent(agent, sessionId);
      const name = resourceName(agent, sessionId, entityTypeId);
      const ownership = yield* internalLabels(id);
      const entities = stampEntities(ownership, news.entities);
      const entityOverrideMode = news.entityOverrideMode ?? DEFAULT_MODE;
      const body: dialogflow.GoogleCloudDialogflowCxV3SessionEntityType = {
        name,
        entities,
        entityOverrideMode,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsSessionsEntityTypes({
            parent,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsSessionsEntityTypeNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const modeChanged =
        (current.entityOverrideMode ?? DEFAULT_MODE) !== entityOverrideMode;
      const entitiesChanged =
        fingerprint(current.entities) !== fingerprint(entities);

      if (modeChanged || entitiesChanged) {
        current =
          // The body always carries both fields; an `entities` update mask
          // is silently ignored by the API, so replace the whole resource.
          yield* dialogflow.patchProjectsLocationsAgentsSessionsEntityTypes({
            name: currentName,
            body: { ...body, name: currentName },
          });
      }

      return toAttrs(current, env.project, agent);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsSessionsEntityTypes({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
