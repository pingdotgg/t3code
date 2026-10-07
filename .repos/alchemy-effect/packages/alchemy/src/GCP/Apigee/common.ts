import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const segmentAfter = (value: string, key: string) => {
  const parts = value.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf(key);
  return index >= 0 && parts[index + 1] ? parts[index + 1]! : undefined;
};

export const stripRevision = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf("revisions");
  return index >= 0 ? parts.slice(0, index).join("/") : name;
};

export const organizationIdOf = (
  value: string | undefined,
  project: string,
) => {
  if (value === undefined || value.length === 0) return project;
  return segmentAfter(value, "organizations") ?? lastSegment(value);
};

export const environmentIdOf = (value: string) =>
  segmentAfter(value, "environments") ?? lastSegment(value);

export const organizationNameOf = (organizationId: string) =>
  `organizations/${organizationId}`;

export const environmentNameOf = (
  organizationId: string,
  environmentId: string,
) => `organizations/${organizationId}/environments/${environmentId}`;

export const parseOrgEnv = (name: string) => ({
  organizationId: segmentAfter(name, "organizations") ?? "",
  environmentId: segmentAfter(name, "environments") ?? "",
});

export const missingToUndefined = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is E & {
        readonly _tag: "NotFound" | "ApigeeResourceNotFound";
      } => error._tag === "NotFound" || error._tag === "ApigeeResourceNotFound",
      () => Effect.succeed(undefined as A | undefined),
    ),
  );

export const emptyOnMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  empty: A,
) =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is E & {
        readonly _tag: "NotFound" | "ApigeeResourceNotFound";
      } => error._tag === "NotFound" || error._tag === "ApigeeResourceNotFound",
      () => Effect.succeed(empty),
    ),
  );

export const deployedConfig = (parent: string) =>
  missingToUndefined(
    apigee.getDeployedConfigOrganizationsEnvironments({
      name: `${parent}/deployedConfig`,
    }),
  );

export const namesFromConfig = (
  items: readonly { name?: string }[] | undefined,
): string[] =>
  (items ?? [])
    .map((item) => item.name)
    .filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    )
    .map((name) => lastSegment(stripRevision(name)));

export const toResourceId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  options?: { maxLength?: number; rfc1035?: boolean },
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const maxLength = options?.maxLength ?? 63;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    if (options?.rfc1035 !== true) return generated;
    let next = generated
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
    if (!/^[a-z]/.test(next)) next = `a${next}`;
    next = next.slice(0, maxLength).replace(/-+$/, "");
    return next.length > 0 ? next : "resource";
  });

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedById = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  [...(left ?? [])].sort().join("\0") === [...(right ?? [])].sort().join("\0");

export type ProjectEnvironment = {
  organizationId: string;
  environmentId: string;
  parent: string;
};

export const listProjectEnvironments = Effect.fn(function* () {
  const env = yield* GcpEnvironment.current;
  const page = yield* emptyOnMissing(
    apigee.listOrganizations({ parent: "organizations" }),
    {
      organizations:
        [] as apigee.GoogleCloudApigeeV1OrganizationProjectMappingList,
    },
  );
  const mappings = (page.organizations ?? []).filter(
    (mapping) =>
      mapping.projectId === env.project ||
      (mapping.projectIds ?? []).includes(env.project),
  );
  const orgs =
    mappings.length > 0
      ? mappings
      : [{ organization: env.project, projectId: env.project }];
  const found: ProjectEnvironment[] = [];
  for (const mapping of orgs) {
    const organizationId = mapping.organization ?? env.project;
    const organization = yield* missingToUndefined(
      apigee.getOrganizations({
        name: organizationNameOf(organizationId),
      }),
    );
    const environments = organization?.environments ?? [];
    for (const environmentId of environments) {
      if (!environmentId) continue;
      found.push({
        organizationId,
        environmentId,
        parent: environmentNameOf(organizationId, environmentId),
      });
    }
  }
  return found;
});

export const listNameArray = (
  values: readonly string[] | undefined,
): string[] =>
  (values ?? []).filter(
    (value) => typeof value === "string" && value.length > 0,
  );

export const namesFromListPayload = (payload: unknown): string[] => {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) =>
      typeof item === "string"
        ? [item]
        : item && typeof item === "object" && "name" in item
          ? typeof (item as { name?: unknown }).name === "string"
            ? [(item as { name: string }).name]
            : []
          : [],
    );
  }
  if (payload && typeof payload === "object") {
    for (const key of [
      "keystores",
      "aliases",
      "keyvaluemaps",
      "references",
      "targetServers",
      "targetservers",
      "values",
    ] as const) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return namesFromListPayload(value);
    }
  }
  return [];
};
