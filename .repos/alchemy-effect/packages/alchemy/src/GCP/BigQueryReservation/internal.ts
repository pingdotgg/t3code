import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
} from "../Labels.ts";

export const MAX_NAME_LENGTH = 64;

/** Locations swept by `list`: the stack region and the multi-regions (the API has no `locations/-` wildcard). */
export const listLocations = (region: string) =>
  Array.from(new Set([region, "US", "EU"]));
const OWNER_PREFIX = "alch---";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (location: string) => {
  const value = lastSegment(location);
  const upper = value.toUpperCase();
  if (upper === "US" || upper === "EU") return upper;
  return value.toLowerCase();
};

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const parseResourceName = (
  name: string,
  collection: "capacityCommitments" | "reservationGroups",
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    resourceId:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

const sanitizeIdPart = (value: string) => {
  const cleaned = sanitizeLabelValue(value)
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned : "x";
};

const ensureId = (value: string) => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
  if (cleaned.length === 0) return "alchx";
  return /^[a-z]/.test(cleaned)
    ? cleaned
    : `a${cleaned}`.slice(0, MAX_NAME_LENGTH);
};

export const encodeOwnershipId = (
  labels: Record<string, string>,
  extra?: string,
): string => {
  let stack = sanitizeIdPart(labels[alchemyLabelKeys.stack] ?? "x");
  let stage = sanitizeIdPart(labels[alchemyLabelKeys.stage] ?? "x");
  let id = sanitizeIdPart(labels[alchemyLabelKeys.id] ?? "x");
  let rest = extra ? sanitizeIdPart(extra) : "";
  const build = () =>
    rest.length > 0
      ? `${OWNER_PREFIX}${stack}---${stage}---${id}---${rest}`
      : `${OWNER_PREFIX}${stack}---${stage}---${id}`;
  let name = build();
  while (name.length > MAX_NAME_LENGTH) {
    if (rest.length > 1) rest = rest.slice(0, -1);
    else if (id.length > 1) id = id.slice(0, -1);
    else if (stack.length > 1) stack = stack.slice(0, -1);
    else if (stage.length > 1) stage = stage.slice(0, -1);
    else break;
    name = build();
  }
  return name.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
};

export const parseOwnershipId = (
  resourceId: string | undefined,
): { labels: Record<string, string> } => {
  const value = resourceId ?? "";
  if (!value.startsWith(OWNER_PREFIX)) return { labels: {} };
  const parts = value.slice(OWNER_PREFIX.length).split("---");
  if (parts.length < 3) return { labels: {} };
  return {
    labels: {
      [alchemyLabelKeys.stack]: parts[0] ?? "",
      [alchemyLabelKeys.stage]: parts[1] ?? "",
      [alchemyLabelKeys.id]: parts[2] ?? "",
    },
  };
};

export const hasOwnershipMarker = (resourceId: string | undefined) =>
  (resourceId ?? "").startsWith("alch-") &&
  Object.keys(parseOwnershipId(resourceId).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, resourceId: string | undefined) =>
  Effect.gen(function* () {
    if (!hasOwnershipMarker(resourceId)) return false;
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnershipId(resourceId);
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        sanitizeIdPart(expected[alchemyLabelKeys.stack] ?? ""),
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        sanitizeIdPart(expected[alchemyLabelKeys.stage] ?? ""),
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        sanitizeIdPart(expected[alchemyLabelKeys.id] ?? ""),
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(id);
    if (requested !== undefined && requested.length > 0) {
      if (requested.startsWith("alch-")) return ensureId(requested);
      return encodeOwnershipId(labels, requested);
    }
    if (existing !== undefined && existing.length > 0) return existing;
    const physical = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return encodeOwnershipId(labels, physical);
  });
