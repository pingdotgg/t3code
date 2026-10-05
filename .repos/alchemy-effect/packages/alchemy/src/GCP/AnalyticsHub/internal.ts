import * as analyticshub from "@distilled.cloud/gcp/analyticshub_v1";
import { Retry as GcpRetry } from "@distilled.cloud/gcp/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

export const MAX_ID_LENGTH = 40;
export const MAX_DISPLAY_NAME_LENGTH = 63;
export const LIST_LOCATIONS = ["us-central1", "US", "EU"] as const;

export class AnalyticshubNotResolved extends Data.TaggedError(
  "GCP.AnalyticsHub.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBool = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left === true) === (right === true);

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length === 0 ? undefined : value;
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

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left) ?? null) ===
  JSON.stringify(canonical(right) ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
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

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
      delimiter: "_",
    });
    let next = generated.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
    if (!/^[a-z]/.test(next)) next = `a${next}`.slice(0, maxLength);
    next = next.slice(0, maxLength).replace(/_+$/g, "");
    return next.length > 0 ? next : "exchange";
  });

export const displayNameOf = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).trim();
  return next.slice(0, MAX_DISPLAY_NAME_LENGTH);
};

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description && description.length > 0
    ? `${marker}\n${description}`
    : marker;
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

export const ownedById = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDescription(description);
    return yield* hasAlchemyLabels(id, labels);
  });

export const sharingKind = (
  config: analyticshub.SharingEnvironmentConfig | undefined,
) => (config?.dcrExchangeConfig !== undefined ? "dcr" : "default");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  previousLocation?: string;
  nextLocation?: string;
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
  const locationChanged =
    (input.previousLocation ?? "") !== "" &&
    (input.nextLocation ?? "") !== "" &&
    (input.previousLocation ?? "").toLowerCase() !==
      (input.nextLocation ?? "").toLowerCase();
  if (!idChanged && !parentChanged && !locationChanged && !input.extra) {
    return undefined;
  }
  return { action: "replace" as const, deleteFirst: false };
};

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => isTransientGcpError(error) || error._tag === "NotFound",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const ignoreGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

const noRetryLayer = Layer.succeed(GcpRetry, { while: () => false });

const isUnavailable = (error: { readonly _tag: string }) =>
  error._tag === "Conflict" ||
  error._tag === "InternalServerError" ||
  error._tag === "ServiceUnavailable" ||
  error._tag === "BadGateway" ||
  error._tag === "GatewayTimeout";

export const deleteRetry = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(noRetryLayer),
    Effect.retry({
      while: isUnavailable,
      times: 12,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const missingGet = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : analyticshub
        .getProjectsLocationsDataExchanges({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk): Item[] => Array.from(chunk)),
  );

export const listDataExchanges = (parent: string) =>
  parent.length === 0
    ? emptyList<analyticshub.DataExchange>()
    : collectPages(
        analyticshub.listProjectsLocationsDataExchanges.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.dataExchanges,
      ).pipe(
        Effect.retry({
          while: isUnavailable,
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () =>
          emptyList<analyticshub.DataExchange>(),
        ),
      );

export const listListings = (parent: string) =>
  parent.length === 0
    ? emptyList<analyticshub.Listing>()
    : collectPages(
        analyticshub.listProjectsLocationsDataExchangesListings.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.listings,
      ).pipe(
        Effect.retry({
          while: isUnavailable,
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () => emptyList<analyticshub.Listing>()),
      );

export const listQueryTemplates = (parent: string) =>
  parent.length === 0
    ? emptyList<analyticshub.QueryTemplate>()
    : collectPages(
        analyticshub.listProjectsLocationsDataExchangesQueryTemplates.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.queryTemplates,
      ).pipe(
        Effect.retry({
          while: isUnavailable,
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () =>
          emptyList<analyticshub.QueryTemplate>(),
        ),
      );

export const listExchangesInProject = (project: string, region: string) =>
  Effect.forEach(
    [...new Set<string>([region, ...LIST_LOCATIONS])],
    (location) => listDataExchanges(locationParent(project, location)),
    { concurrency: 2 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const listChildResources = <A, E, R>(
  parents: readonly { name?: string }[],
  list: (name: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.forEach(
    parents.filter((parent) => (parent.name ?? "").length > 0),
    (parent) => list(parent.name!),
    { concurrency: 4 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const namedOf = <T extends { name?: string }>(items: readonly T[]) =>
  items.filter((item) => (item.name ?? "").length > 0);

export const ownershipLabels = (id: string) => createInternalLabels(id);
