import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_ID_LENGTH = 63;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_DISPLAY_NAME_LENGTH = 128;

export class SecuritycenterNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.NotResolved",
)<{
  name: string;
}> {}

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.OrganizationNotResolved",
)<{
  project: string;
}> {}

export class FolderNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.FolderNotResolved",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectOf = (name: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("projects");
  return index >= 0 ? (parts[index + 1] ?? "") : "";
};

export const organizationOf = (name: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("organizations");
  return index >= 0 ? (parts[index + 1] ?? "") : "";
};

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const organizationIdOf = (value: string) => lastSegment(value);

export const folderParent = (value: string) =>
  value.startsWith("folders/") ? value : `folders/${lastSegment(value)}`;

export const folderIdOf = (value: string) => lastSegment(value);

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const orgsAt = parts.lastIndexOf("organizations");
  const foldersAt = parts.lastIndexOf("folders");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    folder: foldersAt >= 0 && parts[foldersAt + 1] ? parts[foldersAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
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

export const DEFAULT_MUTE_TYPE = "STATIC";
export const DEFAULT_ENABLEMENT = "ENABLED";
export const DEFAULT_CLOUD_PROVIDER = "GOOGLE_CLOUD_PLATFORM";
export const DEFAULT_ETD_TYPE = "CONFIGURABLE_BAD_IP";

export const defaultEtdConfig = {
  metadata: {
    severity: "LOW",
    description: "alchemy custom module",
    recommendation: "n/a",
  },
  ips: ["192.0.2.1"],
};

export const defaultShaCustomConfig = {
  predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
  resourceSelector: {
    resourceTypes: ["compute.googleapis.com/Instance"],
  },
  severity: "LOW",
  description: "alchemy custom module",
  recommendation: "n/a",
};

export const shaSettingsParent = (parent: string) =>
  `${parent}/securityHealthAnalyticsSettings`;

export const etdSettingsParent = (parent: string) =>
  `${parent}/eventThreatDetectionSettings`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left) ?? null) ===
  JSON.stringify(canonical(right) ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  prefix = "s",
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated) ? generated : `${prefix}${generated}`;
    return next.replace(/[^a-z0-9-]/g, "-").slice(0, maxLength);
  });

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) => toResourceId(id, explicit, existing);

export const shaDisplayNameOf = (physical: string) => {
  const cleaned = physical
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withLetter = /^[A-Z]/.test(cleaned)
    ? cleaned
    : `A${cleaned}`.replace(/_+/g, "_");
  return withLetter.slice(0, MAX_DISPLAY_NAME_LENGTH);
};

export const etdDisplayNameOf = (physical: string) => {
  const cleaned = physical
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withLetter = /^[A-Za-z]/.test(cleaned) ? cleaned : `e${cleaned}`;
  return withLetter.slice(0, MAX_DISPLAY_NAME_LENGTH);
};

export const toShaDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const physical = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    return shaDisplayNameOf(physical);
  });

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

export const encodeDescription = encodeOwnership;

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

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const findOwned = <A>(
  items: readonly A[],
  textOf: (item: A) => string | undefined,
  id: string,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, textOf(item))) return item;
    }
    return undefined;
  });

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

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

export const tryResolveFolder = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("folders/")) return current;
      if (current.startsWith("organizations/")) return undefined;
      current = yield* parentOf(current);
    }
    return undefined;
  });

export const resolveFolder = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return folderParent(explicit);
    if (existing !== undefined) return folderParent(existing);
    const resolved = yield* tryResolveFolder();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new FolderNotResolved({ project: env.project });
    }
    return resolved;
  });

export const replaceOnIdentity = (changed: boolean) =>
  changed
    ? ({ action: "replace" as const, deleteFirst: false } as const)
    : undefined;

export const replaceOn = (
  previous: string | undefined,
  next: string | undefined,
) =>
  replaceOnIdentity(
    previous !== undefined && next !== undefined && previous !== next,
  );
