import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { DeleteNotConfirmed } from "../Errors.ts";
import { ALCHEMY_LABEL_PREFIX, stripInternalLabels } from "../Labels.ts";

export const DEFAULT_LOCATION = "global";
export const DEFAULT_FORMAT: parametermanager.ParameterFormatEnum =
  "UNFORMATTED";
export const MAX_NAME_LENGTH = 63;

export class ParameterNotResolved extends Data.TaggedError(
  "GCP.ParameterManager.ParameterNotResolved",
)<{
  name: string;
}> {}

export class ParameterVersionNotResolved extends Data.TaggedError(
  "GCP.ParameterManager.ParameterVersionNotResolved",
)<{
  name: string;
}> {}

export class ParameterVersionPayloadRequired extends Data.TaggedError(
  "GCP.ParameterManager.ParameterVersionPayloadRequired",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const normalizeFormat = (
  format: string | undefined,
): parametermanager.ParameterFormatEnum => {
  const value = (format ?? DEFAULT_FORMAT).toUpperCase();
  if (value === "YAML" || value === "JSON" || value === "UNFORMATTED") {
    return value;
  }
  return DEFAULT_FORMAT;
};

export const rfc1035 = (name: string, fallback: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `p${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

export const parseParameterName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const parametersAt = parts.lastIndexOf("parameters");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    parameterId:
      parametersAt >= 0 && parts[parametersAt + 1]
        ? parts[parametersAt + 1]!
        : lastSegment(name),
    parent: parametersAt > 0 ? parts.slice(0, parametersAt).join("/") : "",
  };
};

export const parseVersionName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const versionsAt = parts.lastIndexOf("versions");
  const parsed = parseParameterName(
    versionsAt > 0 ? parts.slice(0, versionsAt).join("/") : name,
  );
  return {
    ...parsed,
    parameter:
      versionsAt > 0 ? parts.slice(0, versionsAt).join("/") : parsed.parent,
    parameterVersionId:
      versionsAt >= 0 && parts[versionsAt + 1]
        ? parts[versionsAt + 1]!
        : lastSegment(name),
  };
};

export const parameterResourceName = (
  project: string,
  location: string,
  parameterId: string,
) => `projects/${project}/locations/${location}/parameters/${parameterId}`;

export const expandParameter = (
  parameter: string,
  project: string,
  location: string,
) => {
  const next = parameter.replace(/\/+$/, "");
  if (next.includes("/parameters/")) return next;
  const id = lastSegment(next);
  if (id.length === 0) {
    return parameterResourceName(project, location, "parameter");
  }
  if (next.startsWith("projects/")) {
    return `${next}/parameters/${id}`;
  }
  return parameterResourceName(project, location, id);
};

export const versionResourceName = (parameter: string, versionId: string) =>
  `${parameter}/versions/${versionId}`;

export const locationFromParameter = (
  parameter: string | undefined,
  fallback: string,
) => {
  if (parameter === undefined || parameter.length === 0) return fallback;
  if (!parameter.includes("/locations/")) return fallback;
  return parseParameterName(parameter).location || fallback;
};

export const encodeUtf8Base64 = (value: string) =>
  Effect.sync(() => Buffer.from(value, "utf8").toString("base64"));

export const desiredPayloadData = (props: {
  data?: string;
  payload?: { data?: string };
}) =>
  Effect.gen(function* () {
    if (props.payload?.data !== undefined) return props.payload.data;
    if (props.data !== undefined) return yield* encodeUtf8Base64(props.data);
    return undefined;
  });

export const samePayload = (
  left: string | undefined,
  right: string | undefined,
) => {
  const a = left ?? "";
  const b = right ?? "";
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  try {
    return Buffer.from(a, "base64").compare(Buffer.from(b, "base64")) === 0;
  } catch {
    return false;
  }
};

export const getParameter = (name: string) =>
  parametermanager
    .getProjectsLocationsParameters({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getVersion = (name: string) =>
  parametermanager
    .getProjectsLocationsParametersVersions({ name, view: "FULL" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const waitUntilParameterGone = (name: string) =>
  getParameter(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (parameter): boolean => parameter === undefined,
      times: 30,
    }),
    Effect.flatMap((parameter): Effect.Effect<void, DeleteNotConfirmed> =>
      parameter === undefined
        ? Effect.void
        : Effect.fail(new DeleteNotConfirmed({ resource: name })),
    ),
  );

export const waitUntilVersionGone = (name: string) =>
  getVersion(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (version): boolean => version === undefined,
      times: 30,
    }),
    Effect.flatMap((version): Effect.Effect<void, DeleteNotConfirmed> =>
      version === undefined
        ? Effect.void
        : Effect.fail(new DeleteNotConfirmed({ resource: name })),
    ),
  );

const emptyParameters = () =>
  Effect.succeed([] as parametermanager.Parameter[]);

const collectParameterPages = (parent: string) =>
  parametermanager.listProjectsLocationsParameters
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.parameters ?? []),
      ),
      Effect.catchTag("NotFound", () => emptyParameters()),
    );

export const listAlchemyParameters = (project: string) =>
  Effect.gen(function* () {
    const aggregated = yield* collectParameterPages(
      `projects/${project}/locations/-`,
    );
    const parameters =
      aggregated.length > 0
        ? aggregated
        : yield* collectParameterPages(
            `projects/${project}/locations/${DEFAULT_LOCATION}`,
          );
    return parameters.filter((parameter) =>
      hasAlchemyLabelMap(parameter.labels),
    );
  });

const emptyVersions = () =>
  Effect.succeed([] as parametermanager.ParameterVersion[]);

export const listVersions = (parent: string) =>
  parent.length === 0
    ? emptyVersions()
    : parametermanager.listProjectsLocationsParametersVersions
        .pages({
          parent,
          pageSize: 1000,
        })
        .pipe(
          Stream.runCollect,
          Effect.map((pages) =>
            Array.from(pages).flatMap((page) => page.parameterVersions ?? []),
          ),
          // A missing parameter has no versions.
          Effect.catchTag("NotFound", () => emptyVersions()),
        );

export const deleteVersions = (parent: string) =>
  Effect.gen(function* () {
    const versions = yield* listVersions(parent);
    yield* Effect.forEach(
      versions,
      (version) =>
        version.name
          ? parametermanager
              .deleteProjectsLocationsParametersVersions({
                name: version.name,
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void))
          : Effect.void,
      { concurrency: 4 },
    );
  });
