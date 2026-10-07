import * as datalineage from "@distilled.cloud/gcp/datalineage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  desiredAttributes,
  findOwnedRun,
  hasAlchemyAttributeMap,
  listOwnedProcesses,
  listRuns,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  processOf,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  userAttributes,
  waitForOperation,
  waitUntilGone,
} from "./internal.ts";

export type ProcessesRunProps = {
  /**
   * Parent process. Full name
   * `projects/{project}/locations/{location}/processes/{process}` or the
   * process id (combined with `location`). Immutable — changing it
   * replaces the run.
   */
  process: string;
  /**
   * Run id (the `{run}` segment of
   * `.../processes/{process}/runs/{run}`). If omitted, a unique name is
   * generated. Max 200 characters: letters, digits, underscores, hyphens,
   * colons, periods. Immutable — changing it replaces the run.
   */
  runId?: string;
  /**
   * Region used when `process` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * RFC3339 start time. Required by the API; Alchemy reuses the observed
   * value on updates when omitted.
   */
  startTime?: string;
  /**
   * RFC3339 end time.
   */
  endTime?: string;
  /**
   * Run state.
   * @default "STARTED"
   */
  state?:
    | datalineage.GoogleCloudDatacatalogLineageV1RunStateEnum
    | (string & {});
  /**
   * Human-readable name shown in UIs. Max 200 characters.
   */
  displayName?: string;
  /**
   * Non-semantic attributes. Runs have no labels field, so Alchemy stamps
   * `alchemy-stack` / `alchemy-stage` / `alchemy-id` here for `list` /
   * nuke and strips them from attributes.
   */
  attributes?: Record<string, unknown>;
};

export type ProcessesRun = Resource<
  "GCP.DataLineage.ProcessesRun",
  ProcessesRunProps,
  {
    /** Full resource name `.../processes/{process}/runs/{run}`. */
    name: string;
    /** Run id (last path segment). */
    runId: string;
    /** Parent process resource name. */
    process: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 end time. */
    endTime: string | undefined;
    /** Run state (`STARTED`, `COMPLETED`, …). */
    state: string | undefined;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User attributes (Alchemy ownership keys stripped). */
    attributes: Record<string, unknown>;
  },
  never,
  Providers
>;

/**
 * A Data Lineage run — one execution of a process that produces lineage
 * events.
 *
 * Runs have no labels field, so Alchemy stamps ownership into
 * `attributes` for `list` / nuke. Parent process, `runId`, and location
 * are identity. State, timestamps, display name, and attributes update
 * in place.
 *
 * ### Creating a Run
 * **Example:** Started run under a process
 * ```typescript
 * const run = yield* GCP.DataLineage.ProcessesRun("Nightly", {
 *   process: process.name,
 *   startTime: "2024-01-01T00:00:00Z",
 *   state: "STARTED",
 *   attributes: { env: "dev" },
 * });
 * ```
 *
 * **Example:** Completed run
 * ```typescript
 * const run = yield* GCP.DataLineage.ProcessesRun("Nightly", {
 *   process: process.name,
 *   startTime: "2024-01-01T00:00:00Z",
 *   endTime: "2024-01-01T01:00:00Z",
 *   state: "COMPLETED",
 *   displayName: "nightly 2024-01-01",
 * });
 * ```
 *
 * @resource
 * @category DataLineage
 */
export const ProcessesRun = Resource<ProcessesRun>(
  "GCP.DataLineage.ProcessesRun",
);

/** Alias matching the Data Lineage resource name. */
export const Run = ProcessesRun;
export type Run = ProcessesRun;

export class ProcessesRunNotResolved extends Data.TaggedError(
  "GCP.DataLineage.ProcessesRunNotResolved",
)<{
  name: string;
}> {}

const resourceName = (process: string, runId: string) =>
  `${process}/runs/${runId}`;

const nowIso = () => Effect.sync(() => new Date().toISOString());

const toAttrs = (
  run: datalineage.GoogleCloudDatacatalogLineageV1Run,
  project: string,
  region: string,
) => {
  const name = run.name ?? "";
  const parsed = parseName(name, "runs", region);
  return {
    name,
    runId: parsed.id,
    process: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    startTime: run.startTime,
    endTime: run.endTime,
    state: run.state,
    displayName: run.displayName,
    attributes: userAttributes(run.attributes),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalineage
        .getProjectsLocationsProcessesRuns({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ProcessesRunProvider = () =>
  Provider.succeed(ProcessesRun, {
    stables: ["name", "runId", "process", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousProcess = olds?.process ?? output?.process;
      return replaceOnIdentity({
        previousId: olds?.runId ?? output?.runId,
        nextId: news.runId,
        previousParent: previousProcess,
        nextParent: news.process,
        extra: output !== undefined && previousLocation !== nextLocation,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const process = processOf(
        olds?.process ?? output?.process ?? "",
        env.project,
        location,
      );
      const runId = yield* toPhysicalId(id, olds?.runId, output?.runId);
      const name = output?.name ?? resourceName(process, runId);
      const existing =
        (yield* getByName(name)) ?? (yield* findOwnedRun(id, process));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.attributes))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const processes = yield* listOwnedProcesses(env.project, env.region);
        const groups = yield* Effect.forEach(
          processes,
          (process) => listRuns(process.name ?? ""),
          { concurrency: 4 },
        );
        return groups
          .flat()
          .filter((run) => hasAlchemyAttributeMap(run.attributes))
          .map((run) => toAttrs(run, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const process = processOf(news.process, env.project, location);
      const runId = yield* toPhysicalId(id, news.runId, output?.runId);
      const name = output?.name ?? resourceName(process, runId);
      const ownership = yield* createOwnership(id);
      const attributes = desiredAttributes(news.attributes, ownership);

      let current =
        (yield* getByName(name)) ?? (yield* findOwnedRun(id, process));

      if (current === undefined) {
        const startTime = news.startTime ?? (yield* nowIso());
        const created = yield* datalineage
          .createProjectsLocationsProcessesRuns({
            parent: process,
            body: {
              name,
              startTime,
              endTime: news.endTime,
              state: news.state ?? "STARTED",
              displayName: news.displayName,
              attributes,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(name).pipe(
                Effect.flatMap((row) =>
                  row ? Effect.succeed(row) : findOwnedRun(id, process),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProcessesRunNotResolved({ name });
      }

      const resolvedName = current.name ?? name;
      const startTime =
        news.startTime ?? current.startTime ?? (yield* nowIso());
      const endTime = news.endTime ?? current.endTime;
      const state = news.state ?? current.state ?? "STARTED";
      const displayName = news.displayName ?? current.displayName;
      const startChanged = !sameText(current.startTime, startTime);
      const endChanged = !sameText(current.endTime, endTime);
      const stateChanged = !sameText(current.state, state);
      const displayNameChanged = !sameText(current.displayName, displayName);
      const attributesChanged = !sameJson(current.attributes, attributes);

      if (
        startChanged ||
        endChanged ||
        stateChanged ||
        displayNameChanged ||
        attributesChanged
      ) {
        current = yield* datalineage.patchProjectsLocationsProcessesRuns({
          name: resolvedName,
          body: {
            name: resolvedName,
            startTime,
            endTime,
            state,
            displayName,
            attributes,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* datalineage
        .deleteProjectsLocationsProcessesRuns({
          name: output.name,
          allowMissing: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
