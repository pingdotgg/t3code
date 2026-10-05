import { alchemyLabelKeys } from "../Labels.ts";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (project: string) => `projects/${project}`;

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const encodeMarker = (
  labels: Record<string, string>,
  rest: string | undefined,
  separator: string,
): string => {
  const marker = markerOf(labels);
  return rest ? `${marker}${separator}${rest}` : marker;
};

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => encodeMarker(labels, description, "\n");

export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
): string => encodeMarker(labels, displayName, " ");

export const parseMarker = (
  value: string | undefined,
): {
  labels: Record<string, string>;
  rest: string | undefined;
} => {
  if (!value?.startsWith("[alchemy ")) {
    return { labels: {}, rest: value };
  }
  const end = value.indexOf("]");
  if (end < 0) return { labels: {}, rest: value };
  const labels: Record<string, string> = {};
  for (const part of value.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = value.slice(end + 1).replace(/^[\n\s]+/, "");
  return { labels, rest: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (value: string | undefined) =>
  Object.keys(parseMarker(value).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const compactStringMap = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> | undefined => {
  if (value == null) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
};

export const toEmptyObject = (
  value: unknown,
): Record<string, never> | undefined => (value === undefined ? undefined : {});

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};
