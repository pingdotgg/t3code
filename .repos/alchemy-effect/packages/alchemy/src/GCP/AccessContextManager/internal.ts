import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const MAX_TITLE_LENGTH = 256;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_RESOURCE_ID_LENGTH = 50;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.AccessContextManager.NotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.AccessContextManager.StillExists",
)<{
  name: string;
}> {}

export class OrganizationRequired extends Data.TaggedError(
  "GCP.AccessContextManager.OrganizationRequired",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const policyNameOf = (policy: string) =>
  policy.startsWith("accessPolicies/")
    ? policy
    : `accessPolicies/${lastSegment(policy)}`;

export const policyIdOf = (policy: string) => lastSegment(policyNameOf(policy));

export const resourceNameOf = (
  policy: string,
  collection: string,
  id: string,
) => `${policyNameOf(policy)}/${collection}/${id}`;

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const policiesAt = parts.lastIndexOf("accessPolicies");
  const orgsAt = parts.lastIndexOf("organizations");
  return {
    name,
    policyId:
      policiesAt >= 0 && parts[policiesAt + 1] ? parts[policiesAt + 1]! : "",
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const toAcmId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_RESOURCE_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
      delimiter: "_",
    });
    let next = generated.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
    if (!/^[a-zA-Z]/.test(next)) {
      next = `a${next}`;
    }
    next = next.slice(0, maxLength).replace(/_+$/, "");
    return next.length > 0 ? next : "a";
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
      return yield* new OrganizationRequired({ project: env.project });
    }
    return resolved;
  });

export const projectNumberOf = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => lastSegment(resource.name ?? "")),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const normalizeScope = (scope: string, projectNumber?: string) => {
  if (
    scope.startsWith("projects/") ||
    scope.startsWith("folders/") ||
    scope.startsWith("organizations/")
  ) {
    return scope;
  }
  if (/^\d+$/.test(scope)) return `projects/${scope}`;
  if (projectNumber !== undefined && projectNumber.length > 0) {
    return `projects/${projectNumber}`;
  }
  return `projects/${scope}`;
};

export const normalizeScopes = (
  scopes: readonly string[] | undefined,
  projectNumber?: string,
) => (scopes ?? []).map((scope) => normalizeScope(scope, projectNumber));

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
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
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const marker = fitMarker(labels, maxLength);
  const trimmed = text?.trim();
  if (!trimmed) return marker.slice(0, maxLength);
  return `${marker}\n${trimmed}`.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_TITLE_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  const reserved =
    trimmed && trimmed.length > 0
      ? Math.min(trimmed.length + 1, Math.max(0, maxLength - 24))
      : 0;
  const marker = fitMarker(labels, Math.max(24, maxLength - reserved));
  if (!trimmed) return marker.slice(0, maxLength);
  return `${marker} ${trimmed}`.slice(0, maxLength);
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
    key.startsWith("alchemy-"),
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

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listAccessPolicies = (organization: string) =>
  collectPages(
    acm.listAccessPolicies.pages({
      parent: organizationParent(organization),
      pageSize: 100,
    }),
    (page) => page.accessPolicies,
  ).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as acm.AccessPolicy[])),
  );

export const listOwnedPolicies = () =>
  Effect.gen(function* () {
    const organization = yield* tryResolveOrganization();
    if (organization === undefined) return [] as acm.AccessPolicy[];
    const policies = yield* listAccessPolicies(organization);
    return policies.filter((policy) => hasOwnershipMarker(policy.title));
  });

export const resourceNameFromOperation = (
  operation: acm.Operation,
  prefix?: string,
): string | undefined => {
  const name = operation.response?.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (prefix !== undefined && !name.startsWith(prefix)) return undefined;
  return name;
};

/**
 * Wait for an Access Context Manager operation (a few minutes at most) and
 * return the finished operation so callers can read its `response`.
 */
export const waitForOperation = (operation: acm.Operation) =>
  Effect.gen(function* () {
    yield* waitForGcpOperation(
      operation,
      (name) => acm.getOperations({ name }),
      { budget: "10 minutes" },
    );
    if (operation.done === true || !operation.name) return operation;
    return yield* acm.getOperations({ name: operation.name });
  });

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new ResourceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AccessContextManager.NotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new ResourceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AccessContextManager.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const replaceOnIdentity = (changed: boolean) =>
  changed
    ? ({ action: "replace" as const, deleteFirst: false } as const)
    : undefined;
