import * as cloudbilling from "@distilled.cloud/gcp/cloudbilling_v1";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_NAME_LENGTH = 100;
export const DEFAULT_LOCATION = "global";
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_BUCKET_ID = "_Default";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

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

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  prefix: string,
  options?: { delimiter?: string; underscores?: boolean },
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
      delimiter: options?.delimiter,
    });
    let next =
      options?.underscores === true
        ? generated.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_")
        : generated;
    if (!/^[a-z0-9]/.test(next)) {
      next = `${prefix}${next}`;
    }
    return next.slice(0, MAX_NAME_LENGTH);
  });

export const toLinkId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    let next = generated.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
    if (!/^[a-z]/.test(next)) next = `l${next}`;
    return next.replace(/_+$/g, "").slice(0, MAX_NAME_LENGTH) || "link";
  });

export const scopeParent = (project: string, folderId: string | undefined) =>
  folderId !== undefined && folderId.length > 0
    ? `folders/${lastSegment(folderId)}`
    : `projects/${project}`;

export const locationParent = (parent: string, location: string) =>
  `${parent}/locations/${location}`;

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const createOwnership = (id: string) => createInternalLabels(id);

export const ownedBy = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

export type ParsedLoggingName = {
  parent: string;
  location: string | undefined;
  bucketId: string | undefined;
  viewId: string | undefined;
  linkId: string | undefined;
  logScopeId: string | undefined;
  savedQueryId: string | undefined;
  sinkId: string | undefined;
};

export const parseLoggingName = (name: string): ParsedLoggingName => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const get = (key: string) => {
    const index = parts.indexOf(key);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  const folder = get("folders");
  const organization = get("organizations");
  const billingAccount = get("billingAccounts");
  const project = get("projects");
  const parent =
    folder !== undefined
      ? `folders/${folder}`
      : organization !== undefined
        ? `organizations/${organization}`
        : billingAccount !== undefined
          ? `billingAccounts/${billingAccount}`
          : project !== undefined
            ? `projects/${project}`
            : parts.slice(0, 2).join("/");
  return {
    parent,
    location: get("locations"),
    bucketId: get("buckets"),
    viewId: get("views"),
    linkId: get("links"),
    logScopeId: get("logScopes"),
    savedQueryId: get("savedQueries"),
    sinkId: get("sinks"),
  };
};

export const isDeletedBucket = (
  bucket: logging.LogBucket | undefined,
): bucket is undefined =>
  bucket === undefined || bucket.lifecycleState === "DELETE_REQUESTED";

export const isPendingBucket = (state: string | undefined) =>
  state === "CREATING" || state === "UPDATING";

export const canonRestricted = (fields: readonly string[] | undefined) =>
  [...(fields ?? [])].slice().sort();

export type LogBucketIndexConfig = {
  fieldPath: string;
  type: "INDEX_TYPE_STRING" | "INDEX_TYPE_INTEGER";
};

export const canonIndexConfigs = (
  configs:
    | readonly logging.IndexConfig[]
    | readonly LogBucketIndexConfig[]
    | undefined,
): LogBucketIndexConfig[] =>
  [...(configs ?? [])]
    .flatMap((config) =>
      config.fieldPath
        ? [
            {
              fieldPath: config.fieldPath,
              type: (config.type ??
                "INDEX_TYPE_STRING") as LogBucketIndexConfig["type"],
            },
          ]
        : [],
    )
    .sort((left, right) => left.fieldPath.localeCompare(right.fieldPath));

export type SinkExclusion = {
  name: string;
  filter: string;
  description?: string;
  disabled?: boolean;
};

export const exclusionsOf = (
  list: readonly logging.LogExclusion[] | readonly SinkExclusion[] | undefined,
): SinkExclusion[] =>
  (list ?? [])
    .map((exclusion) => ({
      name: exclusion.name ?? "",
      filter: exclusion.filter ?? "",
      description: exclusion.description,
      disabled: exclusion.disabled === true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

export const sameExclusions = (
  left: readonly logging.LogExclusion[] | readonly SinkExclusion[] | undefined,
  right: readonly logging.LogExclusion[] | readonly SinkExclusion[] | undefined,
) => jsonEqual(exclusionsOf(left), exclusionsOf(right));

export const toExclusionsBody = (
  list: readonly SinkExclusion[] | undefined,
): logging.LogExclusion[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((exclusion) => ({
    name: exclusion.name,
    filter: exclusion.filter,
    description: exclusion.description,
    disabled: exclusion.disabled === true ? true : undefined,
  }));
};

export class BillingAccountNotResolved extends Data.TaggedError(
  "GCP.Logging.BillingAccountNotResolved",
)<{
  project: string;
}> {}

export class FolderNotResolved extends Data.TaggedError(
  "GCP.Logging.FolderNotResolved",
)<{
  project: string;
}> {}

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationNotResolved",
)<{
  project: string;
}> {}

export const billingAccountIdOf = (value: string) => lastSegment(value);

export const billingAccountParent = (billingAccountId: string) =>
  billingAccountId.startsWith("billingAccounts/")
    ? billingAccountId
    : `billingAccounts/${billingAccountId}`;

export const folderParent = (folderId: string) =>
  folderId.startsWith("folders/") ? folderId : `folders/${folderId}`;

export const organizationIdOf = (value: string) => lastSegment(value);

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const lookupProjectBillingAccountId = (project: string) =>
  cloudbilling.getBillingInfoProjects({ name: `projects/${project}` }).pipe(
    Effect.map((info) =>
      info.billingAccountName
        ? billingAccountIdOf(info.billingAccountName)
        : undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const resolveBillingAccountId = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return billingAccountIdOf(explicit);
    if (existing !== undefined) return billingAccountIdOf(existing);
    const env = yield* GcpEnvironment.current;
    const resolved = yield* lookupProjectBillingAccountId(env.project);
    if (resolved === undefined) {
      return yield* new BillingAccountNotResolved({ project: env.project });
    }
    return resolved;
  });

export const lookupProjectFolderId = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => {
      const parent = resource.parent ?? "";
      return parent.startsWith("folders/") ? lastSegment(parent) : undefined;
    }),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const resolveFolderId = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return lastSegment(explicit);
    if (existing !== undefined) return lastSegment(existing);
    const env = yield* GcpEnvironment.current;
    const resolved = yield* lookupProjectFolderId(env.project);
    if (resolved === undefined) {
      return yield* new FolderNotResolved({ project: env.project });
    }
    return resolved;
  });

const parentOf = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

export const tryResolveOrganization = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* parentOf(current);
    }
    return undefined;
  });

export const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return organizationParent(explicit);
    if (existing !== undefined) return organizationParent(existing);
    const resolved = yield* tryResolveOrganization();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new OrganizationNotResolved({ project: env.project });
    }
    return resolved;
  });
