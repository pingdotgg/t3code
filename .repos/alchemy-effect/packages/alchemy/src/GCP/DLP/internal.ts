import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import type * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Data from "effect/Data";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

/** Optional deploy-time setting from the ConfigProvider (env by default). */
const optionalSetting = (key: string) =>
  Effect.gen(function* () {
    const value = yield* Config.option(Config.String(key));
    return Option.getOrUndefined(value)?.trim() || undefined;
  });

export const MAX_ID_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_CONTENT_POLICY_DISPLAY_NAME_LENGTH = 63;
export const DEFAULT_LOCATION = "global";
export const DEFAULT_REGIONAL_LOCATION = "us";
/**
 * Locations swept by `list`, alongside the stack region. `us-central1` stays
 * so resources created under the former hard-coded default remain reachable.
 */
export const LIST_LOCATIONS = ["us-central1", "global", "us"] as const;

export class DlpNotResolved extends Data.TaggedError("GCP.DLP.NotResolved")<{
  name: string;
}> {}

export class StoredInfoTypeNotReady extends Data.TaggedError(
  "GCP.DLP.StoredInfoTypeNotReady",
)<{
  name: string;
  state: string | undefined;
}> {}

export class StoredInfoTypeFailed extends Data.TaggedError(
  "GCP.DLP.StoredInfoTypeFailed",
)<{
  name: string;
  state: string;
  message: string;
}> {}

const storedInfoTypeFailure = (
  name: string,
  version: dlp.GooglePrivacyDlpV2StoredInfoTypeVersion | undefined,
) =>
  version?.state === "FAILED" || version?.state === "INVALID"
    ? new StoredInfoTypeFailed({
        name,
        state: version.state,
        message:
          (version.errors ?? [])
            .map((error) => error.details?.message ?? "")
            .filter((message) => message.length > 0)
            .join("; ") || `stored info type version is ${version.state}`,
      })
    : undefined;

/**
 * Poll a stored info type until its current version is `READY` and no
 * pending versions remain (create and update both build a new version
 * asynchronously). Fails on a `FAILED`/`INVALID` version.
 */
export const waitForStoredInfoTypeReady = <
  E extends { readonly _tag: string },
  R,
>(
  name: string,
  get: Effect.Effect<dlp.GooglePrivacyDlpV2StoredInfoType | undefined, E, R>,
) =>
  get.pipe(
    Effect.flatMap(
      (
        stored,
      ): Effect.Effect<
        dlp.GooglePrivacyDlpV2StoredInfoType,
        StoredInfoTypeNotReady | StoredInfoTypeFailed
      > => {
        if (stored === undefined) {
          return Effect.fail(
            new StoredInfoTypeNotReady({ name, state: undefined }),
          );
        }
        const pending = stored.pendingVersions ?? [];
        const failed = storedInfoTypeFailure(
          name,
          pending[pending.length - 1] ?? stored.currentVersion,
        );
        if (failed !== undefined) return Effect.fail(failed);
        if (stored.currentVersion?.state !== "READY" || pending.length > 0) {
          return Effect.fail(
            new StoredInfoTypeNotReady({
              name,
              state: pending[0]?.state ?? stored.currentVersion?.state,
            }),
          );
        }
        return Effect.succeed(stored);
      },
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.DLP.StoredInfoTypeNotReady",
      times: 120,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.DLP.OrganizationNotResolved",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const orgsAt = parts.lastIndexOf("organizations");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
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

export const locationOf = (name: string, fallback = DEFAULT_LOCATION) => {
  const parts = name.split("/");
  const index = parts.indexOf("locations");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

export const organizationOf = (name: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("organizations");
  return index >= 0 ? (parts[index + 1] ?? "") : "";
};

export const projectOf = (name: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("projects");
  return index >= 0 ? (parts[index + 1] ?? "") : "";
};

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const organizationIdOf = (value: string) => lastSegment(value);

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const organizationLocationParent = (
  organization: string,
  location: string,
) => `${organizationParent(organization)}/locations/${location}`;

export const locationParentsOf = (organization: string, region: string) =>
  Array.from(new Set<string>([...LIST_LOCATIONS, region])).map((location) =>
    organizationLocationParent(organization, location),
  );

export const organizationLocationParentsOf = locationParentsOf;

export const normalizeLocation = (
  location: string | undefined,
  fallback = DEFAULT_LOCATION,
) => lastSegment(location ?? fallback).toLowerCase();

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  prefix = "d",
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_ID_LENGTH,
      lowercase: true,
    });
    const next = /^[a-zA-Z]/.test(generated)
      ? generated
      : `${prefix}${generated}`;
    return next.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, MAX_ID_LENGTH);
  });

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) => toResourceId(id, explicit, existing);

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
  maxLength = MAX_DISPLAY_NAME_LENGTH,
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

export const encodeDescription = encodeOwnership;
export const encodeDisplayName = encodeOwnershipLine;

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

export const hybridLabels = (labels: Record<string, string>) => {
  const startLetter = (value: string) =>
    /^[a-z]/.test(value) ? value : `x${value}`.slice(0, 63);
  return {
    [alchemyLabelKeys.stack]: startLetter(
      labels[alchemyLabelKeys.stack] ?? "x",
    ),
    [alchemyLabelKeys.stage]: startLetter(
      labels[alchemyLabelKeys.stage] ?? "x",
    ),
    [alchemyLabelKeys.id]: startLetter(labels[alchemyLabelKeys.id] ?? "x"),
  };
};

export const hasHybridOwnership = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

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
    const fromConfig = yield* optionalSetting("GOOGLE_ORGANIZATION_ID");
    if (fromConfig) return organizationParent(fromConfig);
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
