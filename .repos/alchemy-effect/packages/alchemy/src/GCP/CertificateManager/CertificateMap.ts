import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";

const DEFAULT_LOCATION = "global";
const MAX_NAME_LENGTH = 63;

export type CertificateMapIpConfig = {
  /** External IP address where this map is serving. */
  ipAddress: string | undefined;
  /** Ports on `ipAddress` where this map is serving. */
  ports: number[];
};

export type CertificateMapGclbTarget = {
  /**
   * Target HTTPS proxy using this map
   * (`//compute.googleapis.com/projects/{project}/global/targetHttpsProxies/{proxy}`).
   */
  targetHttpsProxy: string | undefined;
  /**
   * Target SSL proxy using this map
   * (`//compute.googleapis.com/projects/{project}/global/targetSslProxies/{proxy}`).
   */
  targetSslProxy: string | undefined;
  /** IP configurations where this map is serving. */
  ipConfigs: CertificateMapIpConfig[];
};

export type CertificateMapProps = {
  /**
   * Certificate map id (the `{certificateMap}` segment of
   * `projects/{project}/locations/{location}/certificateMaps/{certificateMap}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * certificate map.
   */
  certificateMapId?: string;
  /**
   * Certificate Manager location. Certificate maps are global resources;
   * omit or set `"global"`. Immutable — changing it replaces the map.
   * `GLOBAL` is accepted and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type CertificateMap = Resource<
  "GCP.CertificateManager.CertificateMap",
  CertificateMapProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/certificateMaps/{certificateMap}`. */
    name: string;
    /** Certificate map id (last path segment). */
    certificateMapId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** GCLB targets currently using this map (output-only). */
    gclbTargets: CertificateMapGclbTarget[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Certificate Manager certificate map — a collection of certificate
 * configurations selected by SNI for global external Application and
 * proxy Network Load Balancers.
 *
 * Changing `certificateMapId` or `location` replaces the resource.
 * Description and labels update in place. Certificate maps cannot be
 * deleted while they still contain certificate map entries.
 *
 * ### Creating a Certificate Map
 * **Example:** Generated name
 * ```typescript
 * const map = yield* GCP.CertificateManager.CertificateMap("FrontendMap", {});
 * ```
 *
 * **Example:** Named map with labels
 * ```typescript
 * const map = yield* GCP.CertificateManager.CertificateMap("FrontendMap", {
 *   certificateMapId: "app-frontend",
 *   description: "prod frontend",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Certificate Map
 * **Example:** Description and labels
 * ```typescript
 * const map = yield* GCP.CertificateManager.CertificateMap("FrontendMap", {
 *   certificateMapId: "app-frontend",
 *   description: "prod frontend v2",
 *   labels: { env: "prod", role: "tls" },
 * });
 * ```
 *
 * @resource
 * @category CertificateManager
 */
export const CertificateMap = Resource<CertificateMap>(
  "GCP.CertificateManager.CertificateMap",
);

export class CertificateMapNotResolved extends Data.TaggedError(
  "GCP.CertificateManager.CertificateMapNotResolved",
)<{
  name: string;
}> {}

export class CertificateMapStillExists extends Data.TaggedError(
  "GCP.CertificateManager.CertificateMapStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `c${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "certificatemap";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const resourceName = (
  project: string,
  location: string,
  certificateMapId: string,
) =>
  `projects/${project}/locations/${location}/certificateMaps/${certificateMapId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const mapsAt = parts.lastIndexOf("certificateMaps");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    certificateMapId:
      mapsAt >= 0 && parts[mapsAt + 1] ? parts[mapsAt + 1]! : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  certificateMapId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (certificateMapId !== undefined) return certificateMapId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const toGclbTargets = (
  targets: certificatemanager.GclbTargetList | undefined,
): CertificateMapGclbTarget[] =>
  (targets ?? []).map((target) => ({
    targetHttpsProxy: target.targetHttpsProxy,
    targetSslProxy: target.targetSslProxy,
    ipConfigs: (target.ipConfigs ?? []).map((config) => ({
      ipAddress: config.ipAddress,
      ports: config.ports ?? [],
    })),
  }));

const toAttrs = (map: certificatemanager.CertificateMap, project: string) => {
  const name = map.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    certificateMapId: parsed.certificateMapId,
    project: parsed.project || project,
    location: parsed.location,
    description: map.description,
    labels: userLabels(map.labels),
    gclbTargets: toGclbTargets(map.gclbTargets),
    createTime: map.createTime,
    updateTime: map.updateTime,
  };
};

const getByName = (name: string) =>
  certificatemanager
    .getProjectsLocationsCertificateMaps({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((map) =>
      map
        ? Effect.succeed(map)
        : Effect.fail(new CertificateMapNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.CertificateMapNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((map) =>
      map === undefined
        ? Effect.void
        : Effect.fail(new CertificateMapStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.CertificateMapStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedMaps = (project: string) =>
  certificatemanager.listProjectsLocationsCertificateMaps
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.certificateMaps ?? [])),
      Stream.filter((map) =>
        Object.keys(map.labels ?? {}).some((key) => key.startsWith("alchemy-")),
      ),
      Stream.map((map) => toAttrs(map, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const CertificateMapProvider = () =>
  Provider.succeed(CertificateMap, {
    stables: ["name", "certificateMapId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.certificateMapId ?? output?.certificateMapId;
      const nextId = news.certificateMapId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateMapId = yield* toId(
        id,
        olds?.certificateMapId,
        output?.certificateMapId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, certificateMapId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwnedMaps(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateMapId = yield* toId(
        id,
        news.certificateMapId,
        output?.certificateMapId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, certificateMapId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* certificatemanager
          .createProjectsLocationsCertificateMaps({
            parent: `projects/${env.project}/locations/${location}`,
            certificateMapId,
            body: {
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new CertificateMapNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || descriptionChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* certificatemanager.patchProjectsLocationsCertificateMaps({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* certificatemanager
        .deleteProjectsLocationsCertificateMaps({ name: output.name })
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
      yield* waitUntilGone(output.name);
    }),
  });
