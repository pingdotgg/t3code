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

export type CertificateMapEntryMatcher = "PRIMARY" | (string & {});

export type CertificateMapEntryProps = {
  /**
   * Parent certificate map. Full name
   * `projects/{project}/locations/{location}/certificateMaps/{certificateMap}`
   * or the map id (combined with `location`). Immutable — changing it
   * replaces the entry.
   */
  certificateMap: string;
  /**
   * Certificate map entry id (the `{certificateMapEntry}` segment of
   * `.../certificateMaps/{certificateMap}/certificateMapEntries/{certificateMapEntry}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-zA-Z][a-zA-Z0-9_-]*`. Immutable — changing it replaces the entry.
   */
  certificateMapEntryId?: string;
  /**
   * Certificate Manager location. Used when `certificateMap` is a bare
   * id. Certificate maps are global resources; omit or set `"global"`.
   * Immutable — changing it replaces the entry. `GLOBAL` is accepted and
   * normalized to `global`.
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
  /**
   * Certificate resource names served for this hostname (or PRIMARY
   * matcher). Up to four certificates, each
   * `projects/{project}/locations/{location}/certificates/{certificate}`.
   * Bare certificate ids are qualified with the entry's project and
   * location. Mutable.
   */
  certificates?: string[];
  /**
   * Hostname (FQDN, e.g. `www.example.com`) or wildcard (`*.example.com`)
   * used as SNI. Mutually exclusive with `matcher`. Immutable — changing
   * it replaces the entry.
   */
  hostname?: string;
  /**
   * Predefined matcher when this entry is not selected by SNI. `PRIMARY`
   * is served when the client omits SNI or the hostname is not in the
   * map. Mutually exclusive with `hostname`. Immutable — changing it
   * replaces the entry. If both are set, `hostname` is used.
   */
  matcher?: CertificateMapEntryMatcher;
};

export type CertificateMapEntry = Resource<
  "GCP.CertificateManager.CertificateMapEntry",
  CertificateMapEntryProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/certificateMaps/{certificateMap}/certificateMapEntries/{certificateMapEntry}`. */
    name: string;
    /** Certificate map entry id (last path segment). */
    certificateMapEntryId: string;
    /** Parent certificate map resource name. */
    certificateMap: string;
    /** Parent certificate map id. */
    certificateMapId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Certificate resource names attached to this entry. */
    certificates: string[];
    /** SNI hostname, if this is a hostname entry. */
    hostname: string | undefined;
    /** Predefined matcher (`PRIMARY`), if this is not a hostname entry. */
    matcher: string | undefined;
    /** Serving state (`ACTIVE`, `PENDING`). */
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
 * A Certificate Manager certificate map entry — binds one or more
 * certificates to an SNI hostname (or the PRIMARY fallback) inside a
 * certificate map.
 *
 * Changing `certificateMapEntryId`, `certificateMap`, `location`,
 * `hostname`, or `matcher` replaces the resource. Description, labels,
 * and `certificates` update in place. Hostname and matcher are mutually
 * exclusive; if both are set, hostname is used.
 *
 * ### Creating a Hostname Entry
 * **Example:** SNI hostname
 * ```typescript
 * const cert = yield* GCP.CertificateManager.Certificate("FrontendTls", {
 *   pemCertificate,
 *   pemPrivateKey,
 * });
 * const map = yield* GCP.CertificateManager.CertificateMap("FrontendMap", {});
 * const entry = yield* GCP.CertificateManager.CertificateMapEntry("Www", {
 *   certificateMap: map.name,
 *   certificates: [cert.name],
 *   hostname: "www.example.com",
 * });
 * ```
 *
 * **Example:** Named entry with labels
 * ```typescript
 * const entry = yield* GCP.CertificateManager.CertificateMapEntry("Www", {
 *   certificateMap: map.name,
 *   certificateMapEntryId: "app-www",
 *   description: "prod www",
 *   labels: { env: "prod" },
 *   certificates: [cert.name],
 *   hostname: "www.example.com",
 * });
 * ```
 *
 * ### Primary Fallback
 * **Example:** PRIMARY matcher
 * ```typescript
 * const fallback = yield* GCP.CertificateManager.CertificateMapEntry("Default", {
 *   certificateMap: map.name,
 *   certificates: [cert.name],
 *   matcher: "PRIMARY",
 * });
 * ```
 *
 * ### Updating Certificates
 * **Example:** Attach an extra certificate
 * ```typescript
 * const entry = yield* GCP.CertificateManager.CertificateMapEntry("Www", {
 *   certificateMap: map.name,
 *   certificates: [cert.name, extra.name],
 *   hostname: "www.example.com",
 * });
 * ```
 *
 * @resource
 * @category CertificateManager
 */
export const CertificateMapEntry = Resource<CertificateMapEntry>(
  "GCP.CertificateManager.CertificateMapEntry",
);

export class CertificateMapEntryNotResolved extends Data.TaggedError(
  "GCP.CertificateManager.CertificateMapEntryNotResolved",
)<{
  name: string;
}> {}

export class CertificateMapEntryStillExists extends Data.TaggedError(
  "GCP.CertificateManager.CertificateMapEntryStillExists",
)<{
  name: string;
}> {}

type Match =
  | { kind: "hostname"; hostname: string }
  | { kind: "matcher"; matcher: string };

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
  return next.length > 0 ? next : "certificatemapentry";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const normalizeMatcher = (matcher: string | undefined) => {
  const value = (matcher ?? "").toUpperCase();
  if (value === "" || value === "MATCHER_UNSPECIFIED") return undefined;
  return value;
};

const matchOf = (
  props: { hostname?: string; matcher?: string },
  fallback?: Match,
): Match | undefined => {
  if (props.hostname !== undefined && props.hostname !== "") {
    return { kind: "hostname", hostname: props.hostname };
  }
  const matcher = normalizeMatcher(props.matcher);
  if (matcher !== undefined) {
    return { kind: "matcher", matcher };
  }
  return fallback;
};

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const entriesAt = parts.lastIndexOf("certificateMapEntries");
  const mapsAt = parts.lastIndexOf("certificateMaps");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const certificateMap =
    mapsAt >= 0 ? parts.slice(0, mapsAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    certificateMap,
    certificateMapId:
      mapsAt >= 0 && parts[mapsAt + 1] ? parts[mapsAt + 1]! : "",
    certificateMapEntryId:
      entriesAt >= 0 && parts[entriesAt + 1]
        ? parts[entriesAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  certificateMap: string,
  location: string | undefined,
) => {
  if (certificateMap.includes("/")) {
    const parsed = parseName(
      certificateMap.includes("/certificateMapEntries/")
        ? certificateMap
        : `${certificateMap.replace(/\/+$/, "")}/certificateMapEntries/_`,
    );
    return {
      parent: parsed.certificateMap,
      location: parsed.location,
      project: parsed.project || project,
      certificateMapId: parsed.certificateMapId,
    };
  }
  const loc = normalizeLocation(location);
  return {
    parent: `projects/${project}/locations/${loc}/certificateMaps/${certificateMap}`,
    location: loc,
    project,
    certificateMapId: certificateMap,
  };
};

const parentKey = (
  certificateMap: string | undefined,
  location: string | undefined,
) => {
  if (certificateMap === undefined || certificateMap === "") return undefined;
  const parsed = resolveParent("", certificateMap, location);
  return `${parsed.location}/${parsed.certificateMapId}`;
};

const resourceName = (parent: string, certificateMapEntryId: string) =>
  `${parent}/certificateMapEntries/${certificateMapEntryId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  certificateMapEntryId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (certificateMapEntryId !== undefined) return certificateMapEntryId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const normalizeCertificateName = (
  value: string,
  project: string,
  location: string,
) => {
  if (value.includes("/certificates/")) {
    const parts = value.split("/").filter((part) => part.length > 0);
    const certificatesAt = parts.lastIndexOf("certificates");
    const locationsAt = parts.lastIndexOf("locations");
    const loc =
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : location;
    const certificateId =
      certificatesAt >= 0 && parts[certificatesAt + 1]
        ? parts[certificatesAt + 1]!
        : lastSegment(value);
    return `projects/${project}/locations/${loc}/certificates/${certificateId}`;
  }
  return `projects/${project}/locations/${location}/certificates/${lastSegment(value)}`;
};

const normalizeCertificates = (
  values: readonly string[] | undefined,
  project: string,
  location: string,
) =>
  (values ?? []).map((value) =>
    normalizeCertificateName(value, project, location),
  );

const sameCertificates = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  project: string,
  location: string,
) =>
  [...normalizeCertificates(left, project, location)].sort().join("\0") ===
  [...normalizeCertificates(right, project, location)].sort().join("\0");

const toAttrs = (
  entry: certificatemanager.CertificateMapEntry,
  project: string,
) => {
  const name = entry.name ?? "";
  const parsed = parseName(name);
  const matcher = normalizeMatcher(entry.matcher);
  return {
    name,
    certificateMapEntryId: parsed.certificateMapEntryId,
    certificateMap: parsed.certificateMap,
    certificateMapId: parsed.certificateMapId,
    project: parsed.project || project,
    location: parsed.location,
    description: entry.description,
    labels: userLabels(entry.labels),
    certificates: normalizeCertificates(
      entry.certificates,
      project,
      parsed.location,
    ),
    hostname:
      entry.hostname !== undefined && entry.hostname !== ""
        ? entry.hostname
        : undefined,
    matcher,
    state: entry.state,
    createTime: entry.createTime,
    updateTime: entry.updateTime,
  };
};

const isUsableEntryName = (name: string) =>
  /\/certificateMaps\/[^/]+\/certificateMapEntries\/[^/]+$/.test(name);

const getByName = (name: string) => {
  if (!isUsableEntryName(name)) {
    return Effect.succeed(undefined);
  }
  return certificatemanager
    .getProjectsLocationsCertificateMapsCertificateMapEntries({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
};

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((entry) =>
      entry
        ? Effect.succeed(entry)
        : Effect.fail(new CertificateMapEntryNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.CertificateMapEntryNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((entry) =>
      entry === undefined
        ? Effect.void
        : Effect.fail(new CertificateMapEntryStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.CertificateMapEntryStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listEntriesAt = (parent: string, project: string) =>
  certificatemanager.listProjectsLocationsCertificateMapsCertificateMapEntries
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.certificateMapEntries ?? []),
      ),
      Stream.filter((entry) =>
        Object.keys(entry.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((entry) => toAttrs(entry, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listOwnedEntries = (project: string) =>
  Effect.gen(function* () {
    const maps = yield* certificatemanager.listProjectsLocationsCertificateMaps
      .pages({
        parent: `projects/${project}/locations/-`,
        pageSize: 1000,
      })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.certificateMaps ?? []),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as certificatemanager.CertificateMap[]),
        ),
      );

    const pages = yield* Effect.forEach(
      maps,
      (map) =>
        map.name
          ? listEntriesAt(map.name, project)
          : Effect.succeed([] as ReturnType<typeof toAttrs>[]),
      { concurrency: 4 },
    );
    return pages.flat();
  });

const toCreateBody = (
  news: CertificateMapEntryProps,
  match: Match | undefined,
  certificates: string[],
  desiredLabels: Record<string, string>,
): certificatemanager.CertificateMapEntry => {
  const body: certificatemanager.CertificateMapEntry = {
    description: news.description,
    labels: desiredLabels,
    certificates,
  };
  if (match?.kind === "hostname") {
    body.hostname = match.hostname;
  } else if (match?.kind === "matcher") {
    body.matcher = match.matcher;
  }
  return body;
};

const matchChanged = (
  news: CertificateMapEntryProps,
  olds: Partial<CertificateMapEntryProps> | undefined,
  output: CertificateMapEntry["Attributes"] | undefined,
) => {
  const previous = matchOf({
    hostname: olds?.hostname ?? output?.hostname,
    matcher: olds?.matcher ?? output?.matcher,
  });
  const next = matchOf(news, previous);
  if (previous === undefined || next === undefined) return false;
  if (previous.kind !== next.kind) return true;
  if (
    previous.kind === "hostname" &&
    next.kind === "hostname" &&
    previous.hostname !== next.hostname
  ) {
    return true;
  }
  if (
    previous.kind === "matcher" &&
    next.kind === "matcher" &&
    previous.matcher !== next.matcher
  ) {
    return true;
  }
  return false;
};

export const CertificateMapEntryProvider = () =>
  Provider.succeed(CertificateMapEntry, {
    stables: [
      "name",
      "certificateMapEntryId",
      "certificateMap",
      "certificateMapId",
      "project",
      "location",
      "hostname",
      "matcher",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId =
        olds?.certificateMapEntryId ?? output?.certificateMapEntryId;
      const nextId = news.certificateMapEntryId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousParent = parentKey(
        olds?.certificateMap ?? output?.certificateMap,
        olds?.location ?? output?.location,
      );
      const nextParent =
        news.certificateMap !== undefined
          ? parentKey(
              news.certificateMap,
              news.location ?? olds?.location ?? output?.location,
            )
          : previousParent;

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousParent !== undefined &&
          nextParent !== undefined &&
          previousParent !== nextParent) ||
        matchChanged(news, olds, output);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousParent === nextParent &&
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const mapRef = olds?.certificateMap ?? output?.certificateMap;
      let name = output?.name;
      if (name === undefined || name.length === 0) {
        // Interrupted creates persist parent Outputs as holes (`{}` / "").
        // Don't call GET with `.../certificateMaps//certificateMapEntries/...`.
        if (typeof mapRef !== "string" || mapRef.length === 0) {
          return undefined;
        }
        const certificateMapEntryId = yield* toId(
          id,
          olds?.certificateMapEntryId,
          output?.certificateMapEntryId,
        );
        const parent = resolveParent(
          env.project,
          mapRef,
          olds?.location ?? output?.location,
        );
        name = resourceName(parent.parent, certificateMapEntryId);
      }
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
        return yield* listOwnedEntries(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateMapEntryId = yield* toId(
        id,
        news.certificateMapEntryId,
        output?.certificateMapEntryId,
      );
      const parent = resolveParent(
        env.project,
        news.certificateMap ?? output?.certificateMap ?? "",
        news.location ?? output?.location,
      );
      const name = resourceName(parent.parent, certificateMapEntryId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const match = matchOf(news, matchOf(output ?? {}));
      const certificates = normalizeCertificates(
        news.certificates,
        parent.project,
        parent.location,
      );

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* certificatemanager
          .createProjectsLocationsCertificateMapsCertificateMapEntries({
            parent: parent.parent,
            certificateMapEntryId,
            body: toCreateBody(news, match, certificates, desiredLabels),
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "Conflict" || error._tag === "NotFound",
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
        return yield* new CertificateMapEntryNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const certificatesChanged =
        news.certificates !== undefined &&
        !sameCertificates(
          current.certificates,
          certificates,
          parent.project,
          parent.location,
        );

      if (labelsChanged || descriptionChanged || certificatesChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          certificatesChanged ? "certificates" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* certificatemanager.patchProjectsLocationsCertificateMapsCertificateMapEntries(
            {
              name,
              updateMask: updateMask.join(","),
              body: {
                name,
                labels: desiredLabels,
                description: news.description,
                certificates,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name === undefined || name.length === 0 || !isUsableEntryName(name)) {
        return;
      }
      const operation = yield* certificatemanager
        .deleteProjectsLocationsCertificateMapsCertificateMapEntries({
          name,
        })
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
      yield* waitUntilGone(name);
    }),
  });
