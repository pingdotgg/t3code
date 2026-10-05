import * as apim from "@distilled.cloud/gcp/apim_v1alpha";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ResourceFailed,
  ResourceNotReady,
  ResourceNotResolved,
  expandObservationSource,
  hasAlchemyId,
  listAtLocation,
  collectPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameStringList,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "observationJobs";
const CREATED = new Set(["DISABLED", "ENABLED"]);
const ENABLED = new Set(["ENABLED"]);
const DISABLED = new Set(["DISABLED"]);

export type ObservationJobProps = {
  /**
   * Observation job id (the `{observation_job}` segment of
   * `projects/{project}/locations/{location}/observationJobs/{observation_job}`).
   * Must be 4-63 lowercase letters, digits, or hyphens. If omitted, a
   * unique `alch-` prefixed name is generated. Immutable — changing it
   * replaces the job.
   */
  observationJobId?: string;
  /**
   * Region of the job (`us-central1`, …). Immutable — changing it
   * replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Observation source names
   * (`projects/{project}/locations/{location}/observationSources/{source}`)
   * or bare source ids in the same location. Sources must be the same
   * kind. Immutable — changing them replaces the job.
   */
  sources?: string[];
  /**
   * When true, the job is enabled and collects observations. Synced in
   * place via enable/disable. Jobs are created disabled.
   * @default false
   */
  enabled?: boolean;
};

export type ObservationJob = Resource<
  "GCP.Apim.ObservationJob",
  ObservationJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Observation job id (last path segment). */
    observationJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Observation source resource names. */
    sources: string[];
    /** Whether the job is enabled. */
    enabled: boolean;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API Observation job — configuration that collects data about APIs
 * from attached observation sources. Jobs have no labels, description,
 * or patch API; Alchemy stamps ownership into generated ids (`alch-`)
 * so `list` / nuke can find them. Identity, location, and sources
 * replace the resource. `enabled` is synced in place.
 *
 * ### Creating an Observation Job
 * **Example:** Disabled job with a source
 * ```typescript
 * const job = yield* GCP.Apim.ObservationJob("Shadow", {
 *   sources: [source.name],
 * });
 * ```
 *
 * **Example:** Enable collection
 * ```typescript
 * const job = yield* GCP.Apim.ObservationJob("Shadow", {
 *   sources: [source.name],
 *   enabled: true,
 * });
 * ```
 *
 * @resource
 * @category Apim
 */
export const ObservationJob = Resource<ObservationJob>(
  "GCP.Apim.ObservationJob",
);

const toAttrs = (
  location: string,
  item: apim.ObservationJob,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  const state = item.state;
  return {
    name,
    observationJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    sources: [...(item.sources ?? [])],
    enabled: (state ?? "").toUpperCase() === "ENABLED",
    state,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apim
        .getProjectsLocationsObservationJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    collectPages(
      apim.listProjectsLocationsObservationJobs.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.observationJobs,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item) =>
        hasAlchemyId(parseName(item.name ?? "", COLLECTION).id),
      ),
    ),
  );

const runAndWait = (operation: apim.Operation | undefined) =>
  Effect.gen(function* () {
    if (operation !== undefined) {
      yield* waitForOperation(operation);
    }
  });

export const ObservationJobProvider = () =>
  Provider.succeed(ObservationJob, {
    stables: ["name", "observationJobId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSources = olds?.sources ?? output?.sources;
      return replaceOnIdentity({
        previousId: olds?.observationJobId ?? output?.observationJobId,
        nextId:
          news.observationJobId ??
          olds?.observationJobId ??
          output?.observationJobId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          previousSources !== undefined &&
          news.sources !== undefined &&
          !sameStringList(previousSources, news.sources),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const observationJobId = yield* toPhysicalId(
        id,
        olds?.observationJobId,
        output?.observationJobId,
        "job",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, observationJobId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(location, existing, env.project);
      if (output !== undefined || hasAlchemyId(attrs.observationJobId)) {
        return attrs;
      }
      return Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(env.region, item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const observationJobId = yield* toPhysicalId(
        id,
        news.observationJobId,
        output?.observationJobId,
        "job",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        observationJobId,
      );
      const sources = (news.sources ?? []).map((source) =>
        expandObservationSource(source, env.project, location),
      );
      const wantEnabled = news.enabled === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apim
          .createProjectsLocationsObservationJobs({
            parent: parentOf(env.project, location),
            observationJobId,
            body: {
              sources: sources.length > 0 ? sources : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const resource = current.name ?? name;
      current = yield* waitUntilReady(
        getByName(resource),
        resource,
        (item) => item.state,
        CREATED,
      );

      const state = (current.state ?? "").toUpperCase();
      if (wantEnabled && state !== "ENABLED") {
        const operation = yield* apim
          .enableProjectsLocationsObservationJobs({
            name: resource,
            body: {},
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        yield* runAndWait(operation);
        current = yield* waitUntilReady(
          getByName(resource),
          resource,
          (item) => item.state,
          ENABLED,
        );
      } else if (!wantEnabled && state === "ENABLED") {
        const operation = yield* apim
          .disableProjectsLocationsObservationJobs({
            name: resource,
            body: {},
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        yield* runAndWait(operation);
        current = yield* waitUntilReady(
          getByName(resource),
          resource,
          (item) => item.state,
          DISABLED,
        );
      }

      return toAttrs(location, current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      const state = (existing?.state ?? "").toUpperCase();
      if (
        existing !== undefined &&
        (state === "ENABLED" || state === "ENABLING")
      ) {
        const disable = yield* apim
          .disableProjectsLocationsObservationJobs({
            name: output.name,
            body: {},
          })
          .pipe(
            Effect.catchTag(["NotFound", "Conflict"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (disable !== undefined) {
          yield* waitForOperation(disable, { notFoundOk: true });
        }
        yield* waitUntilReady(
          getByName(output.name),
          output.name,
          (item) => item.state,
          DISABLED,
        ).pipe(
          Effect.catchIf(
            (error) =>
              error instanceof ResourceNotResolved ||
              error instanceof ResourceNotReady ||
              error instanceof ResourceFailed,
            () => Effect.void,
          ),
        );
      }

      const operation = yield* apim
        .deleteProjectsLocationsObservationJobs({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
