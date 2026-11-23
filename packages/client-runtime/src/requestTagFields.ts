import {
  automaticLiteLLMToolValue,
  isCategorizedLiteLLMRequestTag,
  REQUEST_TAG_MAX_CHARS,
  REQUEST_TAGS_MAX,
} from "@t3tools/contracts";
import type { LiteLLMDefaultRequestTag } from "@t3tools/contracts/settings";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const REQUEST_TAG_FIELDS = [
  { category: "jira", label: msg("Jira ticket"), placeholder: msg("PROJ-1234") },
  { category: "project", label: msg("Project"), placeholder: msg("passport") },
  { category: "env", label: msg("Environment"), placeholder: msg("dev") },
  { category: "tool", label: msg("Tool"), placeholder: msg("Automatic") },
] as const;

type RequestTagFieldKey = (typeof REQUEST_TAG_FIELDS)[number]["category"] | "other";

/** One comma-separated string per field, so a field can hold more than one tag. */
export type RequestTagFieldValues = Readonly<Record<RequestTagFieldKey, string>>;

export interface RequestTagFieldsResult {
  readonly tags: ReadonlyArray<string>;
  readonly error: string | null;
}

const FIELD_KEYS: ReadonlyArray<RequestTagFieldKey> = [
  ...REQUEST_TAG_FIELDS.map(({ category }) => category),
  "other",
];

/** Bare tags sit under Project because the server sends them as `project:<tag>`. */
const fieldOfTag = (tag: string): { key: RequestTagFieldKey; value: string } => {
  if (!isCategorizedLiteLLMRequestTag(tag)) return { key: "project", value: tag };
  const field = REQUEST_TAG_FIELDS.find(({ category }) => tag.startsWith(`${category}:`));
  return field
    ? { key: field.category, value: tag.slice(field.category.length + 1).trim() }
    : { key: "other", value: tag };
};

const encodeFieldValue = (key: RequestTagFieldKey, value: string) =>
  key === "other" || value.startsWith(`${key}:`) ? value : `${key}:${value}`;

/** The Tool row shows what the server sends when the field stays blank. */
export function requestTagFieldRows(
  driver: string | undefined,
  defaultTag: LiteLLMDefaultRequestTag,
  resolve: MFunctionType = mFallback,
) {
  const toolPlaceholder =
    defaultTag.mode === "off"
      ? resolve(msg("None"))
      : (automaticLiteLLMToolValue(driver, defaultTag) ?? resolve(msg("Automatic")));
  return [
    ...REQUEST_TAG_FIELDS.map(({ category, label, placeholder }) => ({
      key: category,
      label: resolve(label),
      placeholder: category === "tool" ? toolPlaceholder : resolve(placeholder),
    })),
    {
      key: "other" as const,
      label: resolve(msg("Other tags")),
      placeholder: resolve(msg("team:platform")),
    },
  ];
}

export function requestTagFieldValues(tags: ReadonlyArray<string>): RequestTagFieldValues {
  const fields = tags.map(fieldOfTag);
  const valuesOf = (key: RequestTagFieldKey) =>
    fields
      .filter((field) => field.key === key)
      .map(({ value }) => value)
      .join(", ");
  return {
    jira: valuesOf("jira"),
    project: valuesOf("project"),
    env: valuesOf("env"),
    tool: valuesOf("tool"),
    other: valuesOf("other"),
  };
}

/** A value still in `original` keeps its exact tag, so an edit changes only what was edited. */
export function requestTagsFromFields(
  original: ReadonlyArray<string>,
  values: RequestTagFieldValues,
): RequestTagFieldsResult {
  const fieldKey = (key: RequestTagFieldKey, value: string) => `${key}:${value}`;
  const kept = new Map(
    original.map((tag) => {
      const { key, value } = fieldOfTag(tag);
      return [fieldKey(key, value), tag];
    }),
  );
  const tags = [
    ...new Set(
      FIELD_KEYS.flatMap((key) =>
        values[key]
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) => kept.get(fieldKey(key, value)) ?? encodeFieldValue(key, value)),
      ),
    ),
  ];
  const tooLong = tags.find((tag) => tag.length > REQUEST_TAG_MAX_CHARS);
  const error =
    tooLong !== undefined
      ? `${tooLong.slice(0, 24)}... is too long. Use ${REQUEST_TAG_MAX_CHARS} characters or fewer, with the category.`
      : tags.length > REQUEST_TAGS_MAX
        ? `Use ${REQUEST_TAGS_MAX} tags or fewer.`
        : null;
  return { tags, error };
}

export const sameRequestTags = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  const rightTags = new Set(right);
  return left.length === rightTags.size && left.every((tag) => rightTags.has(tag));
};
