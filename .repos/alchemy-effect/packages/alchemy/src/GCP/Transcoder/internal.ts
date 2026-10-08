import * as transcoder from "@distilled.cloud/gcp/transcoder_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";

export const MAX_ID_LENGTH = 63;
export const MIN_ID_LENGTH = 4;
export const LIST_LOCATIONS = [
  "us-central1",
  "us-east1",
  "us-west1",
  "europe-west1",
  "asia-east1",
] as const;

export class JobTemplateNotResolved extends Data.TaggedError(
  "GCP.Transcoder.JobTemplateNotResolved",
)<{
  name: string;
}> {}

export class JobTemplateStillExists extends Data.TaggedError(
  "GCP.Transcoder.JobTemplateStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const resourceName = (
  project: string,
  location: string,
  jobTemplateId: string,
) => `${locationParent(project, location)}/jobTemplates/${jobTemplateId}`;

export const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const templatesAt = parts.lastIndexOf("jobTemplates");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    jobTemplateId:
      templatesAt >= 0 && parts[templatesAt + 1]
        ? parts[templatesAt + 1]!
        : lastSegment(name),
    parent:
      templatesAt > 0
        ? parts.slice(0, templatesAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const parentOfName = (name: string, defaultLocation: string) => {
  const parsed = parseName(name, defaultLocation);
  return parsed.parent.length > 0
    ? parsed.parent
    : locationParent(parsed.project, parsed.location);
};

/** Job template ids are 4-63 chars matching `[a-zA-Z][a-zA-Z0-9_-]*`. */
export const rfc1035 = (
  name: string,
  maxLength = MAX_ID_LENGTH,
  fallback = "tmpl",
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!/^[a-z]/.test(next)) next = `t${next}`;
  next = next.slice(0, maxLength).replace(/[-_]+$/g, "");
  if (next.length === 0) return fallback.slice(0, maxLength);
  if (next.length < MIN_ID_LENGTH) {
    next = `${next}${fallback}`.slice(0, maxLength);
  }
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const toJobTemplateId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return rfc1035(requested);
    }
    if (existing !== undefined && existing.length > 0) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const desiredLabelsOf = (
  id: string,
  labels: Record<string, string> | undefined,
) =>
  Effect.gen(function* () {
    return {
      ...toLabels(labels),
      ...(yield* createInternalLabels(id)),
    };
  });

export const hasOwnershipMarker = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

export const ownedByAlchemy = (
  id: string,
  labels: Record<string, string | undefined> | null | undefined,
) => hasAlchemyLabels(id, tagRecord(labels));

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
};

export const jsonKey = (value: unknown) =>
  JSON.stringify(stable(value ?? null));

export const labelsKey = (labels: Record<string, string> | undefined): string =>
  jsonKey(toLabels(labels));

export const configKey = (config: transcoder.JobConfig | undefined): string =>
  jsonKey(config);

export const getJobTemplate = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : transcoder
        .getProjectsLocationsJobTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const waitUntilGone = (name: string) =>
  getJobTemplate(name).pipe(
    Effect.flatMap((template) =>
      template === undefined
        ? Effect.void
        : Effect.fail(new JobTemplateStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Transcoder.JobTemplateStillExists",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const emptyList = () => Effect.succeed([] as transcoder.JobTemplate[]);

export const listJobTemplatesAt = (parent: string) =>
  transcoder.listProjectsLocationsJobTemplates
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.jobTemplates ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList()),
    );

export const listOwnedJobTemplates = (project: string, region: string) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(
      [...new Set<string>([region, ...LIST_LOCATIONS])],
      (location) => listJobTemplatesAt(locationParent(project, location)),
      { concurrency: 4 },
    );
    const seen = new Set<string>();
    const owned: transcoder.JobTemplate[] = [];
    for (const row of pages.flat()) {
      const name = row.name ?? "";
      if (name.length > 0 && seen.has(name)) continue;
      if (!hasOwnershipMarker(row.labels)) continue;
      if (name.length > 0) seen.add(name);
      owned.push(row);
    }
    return owned;
  });

export const findOwnedJobTemplate = (
  id: string,
  project: string,
  region: string,
  name?: string,
) =>
  Effect.gen(function* () {
    const existing = yield* getJobTemplate(name ?? "");
    if (existing !== undefined) return existing;
    const rows = yield* listOwnedJobTemplates(project, region);
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.labels)) {
        return row;
      }
    }
    return undefined;
  });
