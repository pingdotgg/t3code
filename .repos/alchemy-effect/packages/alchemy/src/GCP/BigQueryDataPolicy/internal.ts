import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
} from "../Labels.ts";

export const DEFAULT_DATA_POLICY_TYPE = "RAW_DATA_ACCESS_POLICY";
export const MAX_NAME_LENGTH = 200;
/**
 * Locations swept by `list`, alongside the stack region. `us-central1` stays
 * so resources created under the former hard-coded default remain reachable.
 */
export const LIST_LOCATIONS = ["-", "us-central1", "US", "EU"] as const;
const OWNER_PREFIX = "alch___";
const OWNER_SEP = "___";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => {
  const value = lastSegment(location ?? defaultLocation);
  const upper = value.toUpperCase();
  if (upper === "US" || upper === "EU") return upper;
  return value.toLowerCase();
};

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const resourceNameOf = (
  project: string,
  location: string,
  dataPolicyId: string,
) => `${parentOf(project, location)}/dataPolicies/${dataPolicyId}`;

export const parseName = (
  name: string,
  fallbackProject: string,
  fallbackLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf("dataPolicies");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : fallbackProject,
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    dataPolicyId:
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
    .replace(/-/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.length > 0 ? cleaned : "x";
};

const ensureId = (value: string) => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/_+$/g, "");
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
      ? `${OWNER_PREFIX}${stack}${OWNER_SEP}${stage}${OWNER_SEP}${id}${OWNER_SEP}${rest}`
      : `${OWNER_PREFIX}${stack}${OWNER_SEP}${stage}${OWNER_SEP}${id}`;
  let name = build();
  while (name.length > MAX_NAME_LENGTH) {
    if (rest.length > 1) rest = rest.slice(0, -1);
    else if (id.length > 1) id = id.slice(0, -1);
    else if (stack.length > 1) stack = stack.slice(0, -1);
    else if (stage.length > 1) stage = stage.slice(0, -1);
    else break;
    name = build();
  }
  return name.slice(0, MAX_NAME_LENGTH).replace(/_+$/g, "");
};

export const parseOwnershipId = (
  resourceId: string | undefined,
): { labels: Record<string, string> } => {
  const value = resourceId ?? "";
  if (!value.startsWith(OWNER_PREFIX)) return { labels: {} };
  const parts = value.slice(OWNER_PREFIX.length).split(OWNER_SEP);
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
  (resourceId ?? "").startsWith("alch_") &&
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

export const toDataPolicyId = (
  id: string,
  requested: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(id);
    if (requested !== undefined && requested.length > 0) {
      if (requested.startsWith("alch_")) return ensureId(requested);
      return encodeOwnershipId(labels, requested);
    }
    if (existing !== undefined && existing.length > 0) return existing;
    const physical = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
      delimiter: "_",
    });
    return encodeOwnershipId(labels, physical);
  });

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const normalizePolicyType = (value: string | undefined) => {
  const next = (value ?? DEFAULT_DATA_POLICY_TYPE).toUpperCase();
  return next === "DATA_POLICY_TYPE_UNSPECIFIED"
    ? DEFAULT_DATA_POLICY_TYPE
    : next;
};
