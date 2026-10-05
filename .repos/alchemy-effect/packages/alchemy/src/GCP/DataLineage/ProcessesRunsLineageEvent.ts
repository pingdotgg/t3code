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
  fingerprint,
  hasAlchemyAttributeMap,
  listLineageEvents,
  listOwnedProcesses,
  listRuns,
  normalizeLocation,
  parseName,
  processOf,
  replaceOnIdentity,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";

export type LineageEntityReference = {
  /**
   * Fully qualified name of the entity, for example
   * `bigquery:project.dataset.table` or `custom:project.system.table`.
   */
  fullyQualifiedName: string;
  /**
   * Optional nested field path within the entity. Empty for asset-level
   * lineage.
   */
  field?: string[];
};

export type LineageEventLink = {
  /** Source entity. */
  source: LineageEntityReference;
  /** Target entity. */
  target: LineageEntityReference;
  /**
   * How the target depends on the source (`EXACT_COPY` or `OTHER`).
   */
  dependencyType?:
    | datalineage.GoogleCloudDatacatalogLineageV1DependencyInfoDependencyTypeEnum
    | (string & {});
};

export type ProcessesRunsLineageEventProps = {
  /**
   * Parent run. Full name
   * `projects/{project}/locations/{location}/processes/{process}/runs/{run}`
   * or a run id combined with `process`. Immutable — changing it replaces
   * the event.
   */
  run: string;
  /**
   * Parent process used when `run` is a bare id. Full process name or
   * process id combined with `location`.
   */
  process?: string;
  /**
   * Event id (the `{lineage_event}` segment). If omitted, a unique name
   * is generated. Max 200 characters: letters, digits, underscores,
   * hyphens, colons, periods. Immutable — changing it replaces the event.
   */
  lineageEventId?: string;
  /**
   * Region used when `run` / `process` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * RFC3339 start of the transformation. Required by the API; Alchemy
   * reuses the observed value on subsequent reconciles when omitted.
   */
  startTime?: string;
  /**
   * RFC3339 end of the transformation.
   */
  endTime?: string;
  /**
   * Source-target links (max 100). Lineage events have no labels or
   * attributes field, so Alchemy lists events under alchemy-owned
   * parent processes for nuke.
   */
  links?: LineageEventLink[];
};

export type ProcessesRunsLineageEvent = Resource<
  "GCP.DataLineage.ProcessesRunsLineageEvent",
  ProcessesRunsLineageEventProps,
  {
    /** Full resource name `.../runs/{run}/lineageEvents/{lineage_event}`. */
    name: string;
    /** Lineage event id (last path segment). */
    lineageEventId: string;
    /** Parent run resource name. */
    run: string;
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
    /** Source-target links. */
    links: LineageEventLink[];
  },
  never,
  Providers
>;

/**
 * A Data Lineage event — one operation that moved data from source
 * assets to target assets.
 *
 * Events are immutable after create (no patch API). Identity is the
 * parent run plus `lineageEventId`. Changing links or timestamps
 * replaces the event. Events have no labels, so `list` / nuke walks
 * alchemy-owned parent processes.
 *
 * ### Creating a Lineage Event
 * **Example:** One source-to-target link
 * ```typescript
 * const event = yield* GCP.DataLineage.ProcessesRunsLineageEvent("Load", {
 *   run: run.name,
 *   startTime: "2024-01-01T00:00:00Z",
 *   links: [
 *     {
 *       source: { fullyQualifiedName: "custom:proj.raw.orders" },
 *       target: { fullyQualifiedName: "custom:proj.dw.orders" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category DataLineage
 */
export const ProcessesRunsLineageEvent = Resource<ProcessesRunsLineageEvent>(
  "GCP.DataLineage.ProcessesRunsLineageEvent",
);

/** Alias matching the Data Lineage resource name. */
export const LineageEvent = ProcessesRunsLineageEvent;
export type LineageEvent = ProcessesRunsLineageEvent;

export class ProcessesRunsLineageEventNotResolved extends Data.TaggedError(
  "GCP.DataLineage.ProcessesRunsLineageEventNotResolved",
)<{
  name: string;
}> {}

const resourceName = (run: string, lineageEventId: string) =>
  `${run}/lineageEvents/${lineageEventId}`;

const nowIso = () => Effect.sync(() => new Date().toISOString());

const runOf = (
  run: string,
  process: string | undefined,
  project: string,
  location: string,
) => {
  if (run.includes("/")) return run.replace(/\/+$/, "");
  const parent = processOf(process ?? "", project, location);
  return `${parent}/runs/${run}`;
};

const linksOf = (
  links: readonly LineageEventLink[] | undefined,
): datalineage.GoogleCloudDatacatalogLineageV1EventLink[] =>
  (links ?? []).map((link) => ({
    source: {
      fullyQualifiedName: link.source.fullyQualifiedName,
      field: link.source.field,
    },
    target: {
      fullyQualifiedName: link.target.fullyQualifiedName,
      field: link.target.field,
    },
    dependencyInfo:
      link.dependencyType !== undefined
        ? { dependencyType: link.dependencyType }
        : undefined,
  }));

const linksFrom = (
  links:
    | readonly datalineage.GoogleCloudDatacatalogLineageV1EventLink[]
    | undefined,
): LineageEventLink[] =>
  (links ?? [])
    .filter(
      (link) =>
        (link.source?.fullyQualifiedName ?? "").length > 0 &&
        (link.target?.fullyQualifiedName ?? "").length > 0,
    )
    .map((link) => ({
      source: {
        fullyQualifiedName: link.source?.fullyQualifiedName ?? "",
        field: link.source?.field,
      },
      target: {
        fullyQualifiedName: link.target?.fullyQualifiedName ?? "",
        field: link.target?.field,
      },
      dependencyType: link.dependencyInfo?.dependencyType,
    }));

const toAttrs = (
  event: datalineage.GoogleCloudDatacatalogLineageV1LineageEvent,
  project: string,
  region: string,
) => {
  const name = event.name ?? "";
  const parsed = parseName(name, "lineageEvents", region);
  const process = parseName(parsed.parent, "runs", region).parent;
  return {
    name,
    lineageEventId: parsed.id,
    run: parsed.parent,
    process,
    project: parsed.project || project,
    location: parsed.location,
    startTime: event.startTime,
    endTime: event.endTime,
    links: linksFrom(event.links),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalineage
        .getProjectsLocationsProcessesRunsLineageEvents({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getProcess = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalineage
        .getProjectsLocationsProcesses({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const identityFingerprint = (news: {
  startTime?: string;
  endTime?: string;
  links?: LineageEventLink[];
}) =>
  fingerprint({
    startTime: news.startTime,
    endTime: news.endTime,
    links: linksOf(news.links),
  });

export const ProcessesRunsLineageEventProvider = () =>
  Provider.succeed(ProcessesRunsLineageEvent, {
    stables: [
      "name",
      "lineageEventId",
      "run",
      "process",
      "project",
      "location",
    ],

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
      const previous = identityFingerprint({
        startTime: olds?.startTime ?? output?.startTime,
        endTime: olds?.endTime ?? output?.endTime,
        links: olds?.links ?? output?.links,
      });
      const next = identityFingerprint({
        startTime: news.startTime ?? olds?.startTime ?? output?.startTime,
        endTime: news.endTime ?? olds?.endTime ?? output?.endTime,
        links: news.links ?? olds?.links ?? output?.links,
      });
      return replaceOnIdentity({
        previousId: olds?.lineageEventId ?? output?.lineageEventId,
        nextId: news.lineageEventId,
        previousParent: olds?.run ?? output?.run,
        nextParent: news.run,
        extra:
          (output !== undefined && previousLocation !== nextLocation) ||
          (output !== undefined && previous !== next),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const run = runOf(
        olds?.run ?? output?.run ?? "",
        olds?.process ?? output?.process,
        env.project,
        location,
      );
      const lineageEventId = yield* toPhysicalId(
        id,
        olds?.lineageEventId,
        output?.lineageEventId,
      );
      const name = output?.name ?? resourceName(run, lineageEventId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const parent = yield* getProcess(attrs.process);
      return parent === undefined || hasAlchemyAttributeMap(parent.attributes)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const processes = yield* listOwnedProcesses(env.project, env.region);
        const runs = (yield* Effect.forEach(
          processes,
          (process) => listRuns(process.name ?? ""),
          { concurrency: 4 },
        )).flat();
        const events = (yield* Effect.forEach(
          runs,
          (run) => listLineageEvents(run.name ?? ""),
          { concurrency: 4 },
        )).flat();
        return events.map((event) => toAttrs(event, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const run = runOf(news.run, news.process, env.project, location);
      const lineageEventId = yield* toPhysicalId(
        id,
        news.lineageEventId,
        output?.lineageEventId,
      );
      const name = output?.name ?? resourceName(run, lineageEventId);

      let current = yield* getByName(name);

      if (current === undefined) {
        const startTime = news.startTime ?? (yield* nowIso());
        const created = yield* datalineage
          .createProjectsLocationsProcessesRunsLineageEvents({
            parent: run,
            body: {
              name,
              startTime,
              endTime: news.endTime,
              links: linksOf(news.links),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProcessesRunsLineageEventNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* datalineage
        .deleteProjectsLocationsProcessesRunsLineageEvents({
          name: output.name,
          allowMissing: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
