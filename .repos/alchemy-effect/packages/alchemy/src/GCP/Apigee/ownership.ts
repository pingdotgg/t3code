import type * as apigee from "@distilled.cloud/gcp/apigee_v1";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export { createInternalLabels, hasAlchemyLabels };

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const orgIdOf = (value: string | undefined, project?: string) =>
  lastSegment(value ?? project ?? "");

export const orgParent = (org: string) =>
  org.startsWith("organizations/") ? org : `organizations/${org}`;

export const xmlEscape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const xmlUnescape = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

export const encodeOwnership = (
  labels: Record<string, string>,
  userText: string | undefined,
  extra?: Record<string, string>,
): string => {
  const pairs = [
    `${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]}`,
    `${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]}`,
    `${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}`,
    ...Object.entries(extra ?? {}).map(([key, value]) => `${key}=${value}`),
  ];
  const marker = `[alchemy ${pairs.join(" ")}]`;
  return userText ? `${marker}\n${userText}` : marker;
};

export const parseOwnership = (
  value: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!value?.startsWith("[alchemy ")) {
    return { labels: {}, text: value };
  }
  const end = value.indexOf("]");
  if (end < 0) return { labels: {}, text: value };
  const labels: Record<string, string> = {};
  for (const part of value.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = value.slice(end + 1).replace(/^\s+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (value: string | undefined) =>
  Object.keys(parseOwnership(value).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
  maxLength?: number,
): string => {
  const encoded = encodeOwnership(labels, description);
  return maxLength !== undefined ? encoded.slice(0, maxLength) : encoded;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  const parsed = parseOwnership(description);
  return { labels: parsed.labels, description: parsed.text };
};

export const encodeComments = (
  labels: Record<string, string>,
  comments: readonly string[] | undefined,
): string[] => {
  const marker = encodeOwnership(labels, undefined);
  const rest = (comments ?? []).filter(
    (comment) => !comment.startsWith("[alchemy "),
  );
  return [marker, ...rest];
};

export const parseComments = (
  comments: readonly string[] | undefined,
): {
  labels: Record<string, string>;
  comments: string[];
} => {
  const list = [...(comments ?? [])];
  const marked = list.find((comment) => comment.startsWith("[alchemy "));
  const parsed = parseOwnership(marked);
  return {
    labels: parsed.labels,
    comments: list.filter((comment) => !comment.startsWith("[alchemy ")),
  };
};

export const commentsHaveOwnership = (
  comments: readonly string[] | undefined,
) =>
  hasOwnershipMarker(
    comments?.find((comment) => comment.startsWith("[alchemy ")),
  );

export type Attribute = {
  name?: string;
  value?: string;
};

const isAttributeObject = (
  value: readonly Attribute[] | { attribute?: readonly Attribute[] },
): value is { attribute?: readonly Attribute[] } => !Array.isArray(value);

const attributeList = (
  value:
    | readonly Attribute[]
    | { attribute?: readonly Attribute[] }
    | undefined,
): Attribute[] => {
  if (value === undefined) return [];
  if (isAttributeObject(value)) return [...(value.attribute ?? [])];
  return [...value];
};

export const fromAttributes = (
  value:
    | readonly Attribute[]
    | { attribute?: readonly Attribute[] }
    | undefined,
): {
  labels: Record<string, string>;
  attributes: Record<string, string>;
} => {
  const labels: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  for (const item of attributeList(value)) {
    if (item.name === undefined) continue;
    const next = item.value ?? "";
    if (item.name.startsWith("alchemy-")) labels[item.name] = next;
    else attributes[item.name] = next;
  }
  return { labels, attributes };
};

const isAttributeArray = (
  value: Record<string, string> | readonly Attribute[],
): value is readonly Attribute[] => Array.isArray(value);

export const toAttributes = (
  ownership: Record<string, string>,
  user?: Record<string, string> | readonly Attribute[],
): Attribute[] => {
  const record =
    user === undefined
      ? {}
      : isAttributeArray(user)
        ? fromAttributes(user).attributes
        : user;
  return Object.entries({ ...record, ...ownership }).map(([name, value]) => ({
    name,
    value,
  }));
};

export const userAttributeList = (
  value:
    | readonly Attribute[]
    | { attribute?: readonly Attribute[] }
    | undefined,
): Attribute[] =>
  Object.entries(fromAttributes(value).attributes).map(([name, value]) => ({
    name,
    value,
  }));

const OWNERSHIP_EXTENSION = "alchown";

const sanitizeHostname = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "x";

export const withOwnershipExtension = (
  labels: Record<string, string>,
  extensions:
    | readonly apigee.GoogleCloudApigeeV1ApimServiceExtensionExtension[]
    | undefined,
): apigee.GoogleCloudApigeeV1ApimServiceExtensionExtension[] => [
  {
    name: OWNERSHIP_EXTENSION,
    hostname: [
      sanitizeHostname(labels[alchemyLabelKeys.stack] ?? "stack"),
      sanitizeHostname(labels[alchemyLabelKeys.stage] ?? "stage"),
      sanitizeHostname(labels[alchemyLabelKeys.id] ?? "id"),
    ].join("."),
    matchCondition: "false",
  },
  ...(extensions ?? []).filter(
    (extension) => extension.name !== OWNERSHIP_EXTENSION,
  ),
];

export const parseOwnershipExtension = (
  extensions:
    | readonly apigee.GoogleCloudApigeeV1ApimServiceExtensionExtension[]
    | undefined,
): Record<string, string> => {
  const found = (extensions ?? []).find(
    (extension) => extension.name === OWNERSHIP_EXTENSION,
  );
  if (found?.hostname === undefined) return {};
  const [stack, stage, ...idParts] = found.hostname.split(".");
  if (stack === undefined || stage === undefined || idParts.length === 0) {
    return {};
  }
  return {
    [alchemyLabelKeys.stack]: stack,
    [alchemyLabelKeys.stage]: stage,
    [alchemyLabelKeys.id]: idParts.join("."),
  };
};

export const hasOwnershipExtension = (
  extensions:
    | readonly apigee.GoogleCloudApigeeV1ApimServiceExtensionExtension[]
    | undefined,
) =>
  (extensions ?? []).some(
    (extension) => extension.name === OWNERSHIP_EXTENSION,
  );

export const stripOwnershipExtension = (
  extensions:
    | readonly apigee.GoogleCloudApigeeV1ApimServiceExtensionExtension[]
    | undefined,
) =>
  (extensions ?? []).filter(
    (extension) => extension.name !== OWNERSHIP_EXTENSION,
  );
