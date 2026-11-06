import * as Category from "@distilled.cloud/core/category";
import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as GcpRetry from "@distilled.cloud/gcp/Retry";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * The Dialogflow suite runs ~20 files at once against one project, which
 * overruns the per-minute "All other requests" quota. Distilled's default
 * backoff gives up before the minute rolls over, so the suite rides it out.
 */
export const quotaTolerant = GcpRetry.policy({
  while: (error) => Category.isThrottling(error) || Category.isTransientError(error),
  schedule: Schedule.max([Schedule.spaced("10 seconds"), Schedule.recurs(12)]),
});

export const DEFAULT_LOCATION = "global";

export const locationParent = (project: string, location = DEFAULT_LOCATION) =>
  `projects/${project}/locations/${location}`;

export const getAgent = (name: string) =>
  dialogflow
    .getProjectsLocationsAgents({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAgents = (parent: string) =>
  dialogflow.listProjectsLocationsAgents.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.agents ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const ensureAgent = (project: string, displayName: string, location = DEFAULT_LOCATION) =>
  Effect.gen(function* () {
    const parent = locationParent(project, location);
    const agents = yield* listAgents(parent);
    const existing = agents.find((agent) => agent.displayName === displayName);
    if (existing?.name) {
      const current = yield* getAgent(existing.name);
      if (current !== undefined) return current;
    }
    return yield* dialogflow.createProjectsLocationsAgents({
      parent,
      body: {
        displayName,
        defaultLanguageCode: "en",
        timeZone: "America/Los_Angeles",
        description: displayName,
      },
    });
  });

export const deleteAgent = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0) return;
    const existing = yield* getAgent(name);
    if (existing === undefined) return;
    yield* dialogflow
      .deleteProjectsLocationsAgents({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  }).pipe(Effect.ignore);

export const getEntityType = (name: string) =>
  dialogflow
    .getProjectsLocationsAgentsEntityTypes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ensureEntityType = (agent: string, displayName: string) =>
  Effect.gen(function* () {
    const listed = yield* dialogflow.listProjectsLocationsAgentsEntityTypes
      .pages({ parent: agent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.entityTypes ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
    const existing = listed.find((entityType) => entityType.displayName === displayName);
    if (existing?.name) {
      const current = yield* getEntityType(existing.name);
      if (current !== undefined) return current;
    }
    return yield* dialogflow.createProjectsLocationsAgentsEntityTypes({
      parent: agent,
      body: {
        displayName,
        kind: "KIND_MAP",
        entities: [{ value: "blue", synonyms: ["blue", "navy"] }],
      },
    });
  });

export const deleteEntityType = (name: string) =>
  dialogflow
    .deleteProjectsLocationsAgentsEntityTypes({ name, force: true })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
