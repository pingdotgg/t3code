import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  ALCHEMY_LABEL_PREFIX,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const MAX_NAME_LENGTH = 63;
export const MAX_DESCRIPTION_LENGTH = 8000;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.ML.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.ML.ResourceStillExists",
)<{
  name: string;
}> {}

export class VersionNotReady extends Data.TaggedError(
  "GCP.ML.VersionNotReady",
)<{
  name: string;
  state: string;
}> {}

export class VersionFailed extends Data.TaggedError("GCP.ML.VersionFailed")<{
  name: string;
  message: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const rfc1035 = (name: string, fallback: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `m${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return rfc1035(lastSegment(explicit), fallback);
    }
    if (existing !== undefined && existing.length > 0) {
      return lastSegment(existing);
    }
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const projectParent = (project: string) => `projects/${project}`;

export const modelResourceName = (project: string, modelId: string) =>
  `${projectParent(project)}/models/${modelId}`;

export const versionResourceName = (modelName: string, versionId: string) =>
  `${modelName}/versions/${versionId}`;

export const expandModel = (project: string, value: string) => {
  const next = value.replace(/\/+$/, "");
  if (next.includes("/models/")) return next;
  return modelResourceName(project, lastSegment(next));
};

export const parseModelName = (name: string, fallbackProject = "") => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const modelsAt = parts.lastIndexOf("models");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : fallbackProject,
    modelId:
      modelsAt >= 0 && parts[modelsAt + 1]
        ? parts[modelsAt + 1]!
        : lastSegment(name),
    parent:
      modelsAt > 0 ? parts.slice(0, modelsAt).join("/") : projectParent(""),
  };
};

export const parseVersionName = (name: string, fallbackProject = "") => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const versionsAt = parts.lastIndexOf("versions");
  const parsed = parseModelName(name, fallbackProject);
  return {
    ...parsed,
    versionId:
      versionsAt >= 0 && parts[versionsAt + 1]
        ? parts[versionsAt + 1]!
        : lastSegment(name),
    model:
      versionsAt > 0
        ? parts.slice(0, versionsAt).join("/")
        : modelResourceName(parsed.project, parsed.modelId),
  };
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(
    [...(left ?? [])].map((value) => value.toLowerCase()).sort(),
  ) ===
  JSON.stringify([...(right ?? [])].map((value) => value.toLowerCase()).sort());

export const normalizeRegions = (
  regions: readonly string[] | undefined,
  fallback: readonly string[],
): string[] => {
  const next = [...(regions ?? [])]
    .map((region) => lastSegment(region).toLowerCase())
    .filter((region) => region.length > 0);
  return next.length > 0 ? next : [...fallback];
};

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.length <= maxLength
    ? marker
    : `${marker.slice(0, Math.max(0, maxLength - 1))}]`;
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const marker = fitMarker(labels, maxLength);
  const trimmed = text?.trim();
  if (!trimmed) return marker;
  return `${marker}\n${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith(ALCHEMY_LABEL_PREFIX),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const modelOwnedByAlchemy = (
  id: string,
  model: ml.GoogleCloudMlV1__Model,
) =>
  Effect.gen(function* () {
    if (yield* hasAlchemyLabels(id, tagRecord(model.labels))) return true;
    return yield* ownedByAlchemy(id, model.description);
  });

export const versionOwnedByAlchemy = (
  id: string,
  version: ml.GoogleCloudMlV1__Version,
) =>
  Effect.gen(function* () {
    if (yield* hasAlchemyLabels(id, tagRecord(version.labels))) return true;
    return yield* ownedByAlchemy(id, version.description);
  });

export const modelHasOwnership = (model: ml.GoogleCloudMlV1__Model) =>
  hasAlchemyLabelMap(model.labels) || hasOwnershipMarker(model.description);

export const versionHasOwnership = (version: ml.GoogleCloudMlV1__Version) =>
  hasAlchemyLabelMap(version.labels) || hasOwnershipMarker(version.description);

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  if (!idChanged && !parentChanged && input.extra !== true) {
    return undefined;
  }
  return {
    action: "replace" as const,
    deleteFirst:
      !idChanged &&
      !parentChanged &&
      input.extra === true &&
      input.previousId !== undefined &&
      input.nextId === input.previousId,
  };
};

export const getModel = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ml
        .getProjectsModels({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getVersion = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ml
        .getProjectsModelsVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const emptyList = <A>() => Effect.succeed([] as A[]);

export const listModels = (project: string) =>
  ml.listProjectsModels
    .pages({
      parent: projectParent(project),
      pageSize: 100,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.models ?? []),
      ),
      Effect.catchTag("NotFound", () => emptyList<ml.GoogleCloudMlV1__Model>()),
    );

export const listVersions = (parent: string) =>
  parent.length === 0
    ? emptyList<ml.GoogleCloudMlV1__Version>()
    : ml.listProjectsModelsVersions
        .pages({
          parent,
          pageSize: 100,
        })
        .pipe(
          Stream.runCollect,
          Effect.map((pages) =>
            Array.from(pages).flatMap((page) => page.versions ?? []),
          ),
          Effect.catchTag("NotFound", () =>
            emptyList<ml.GoogleCloudMlV1__Version>(),
          ),
        );

export const listOwnedModels = (project: string) =>
  listModels(project).pipe(
    Effect.map((models) => models.filter(modelHasOwnership)),
  );

export const listOwnedVersions = (project: string) =>
  Effect.gen(function* () {
    const models = yield* listOwnedModels(project);
    const pages = yield* Effect.forEach(
      models,
      (model) =>
        model.name
          ? listVersions(model.name)
          : emptyList<ml.GoogleCloudMlV1__Version>(),
      { concurrency: 4 },
    );
    return pages.flat().filter((version) => versionHasOwnership(version));
  });

type Tagged = { readonly _tag: string };

const versionState = (version: ml.GoogleCloudMlV1__Version) =>
  (version.state ?? "").toUpperCase();

export const waitUntilGone = <A, R>(
  get: Effect.Effect<A, Tagged, R>,
  name: string,
): Effect.Effect<void, Tagged, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ML.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilExists = <A, R>(
  get: Effect.Effect<A, Tagged, R>,
  name: string,
): Effect.Effect<Exclude<A, undefined>, Tagged, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is Exclude<A, undefined> => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ML.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilVersionReady = (
  name: string,
): Effect.Effect<
  ml.GoogleCloudMlV1__Version,
  | ml.Forbidden
  | ml.GcpOpError
  | ResourceNotResolved
  | VersionFailed
  | VersionNotReady,
  ml.GcpOpContext
> =>
  getVersion(name).pipe(
    Effect.filterOrFail(
      (version): version is ml.GoogleCloudMlV1__Version =>
        version !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (version) => {
        const state = versionState(version);
        return state === "" || state === "READY" || state === "FAILED";
      },
      (version) =>
        new VersionNotReady({
          name,
          state: version.state ?? "",
        }),
    ),
    Effect.flatMap(
      (version): Effect.Effect<ml.GoogleCloudMlV1__Version, VersionFailed> =>
        versionState(version) === "FAILED"
          ? Effect.fail(
              new VersionFailed({
                name,
                message: version.errorMessage ?? "version failed",
              }),
            )
          : Effect.succeed(version),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ML.ResourceNotResolved" ||
        error._tag === "GCP.ML.VersionNotReady",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );
