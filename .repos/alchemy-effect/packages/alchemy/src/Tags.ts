import * as Effect from "effect/Effect";
import { Stack } from "./Stack.ts";
import { Stage } from "./Stage.ts";

export type Tags =
  | Record<string, string | undefined>
  | [string, string][]
  | { Key: string; Value: string }[];

export const normalizeTags = (tags: Tags) =>
  Array.isArray(tags)
    ? Object.fromEntries(
        tags.map((tag) =>
          Array.isArray(tag) ? [tag[0], tag[1]] : [tag.Key, tag.Value],
        ),
      )
    : tags;

export const tagRecord = (tags: Tags | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(normalizeTags(tags ?? {})).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const hasTags = (expectedTags: Tags, tags: Tags | undefined) => {
  const actualTags = normalizeTags(tags ?? []);
  return Object.entries(normalizeTags(expectedTags)).every(
    ([key, value]) => actualTags[key] === value,
  );
};

export const createTagsList = (tags: Tags) =>
  Object.entries(normalizeTags(tags))
    .filter((t): t is [string, string] => t[1] !== undefined)
    .map(([Key, Value]) => ({
      Key,
      Value,
    }));

export const createInternalTags = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return {
    "alchemy::stack": stack.name,
    "alchemy::stage": stage,
    "alchemy::id": id,
  };
});

/**
 * Strips the internal `alchemy::*` ownership tags from a tag/label map, leaving
 * only the user-facing entries. Useful when diffing observed cloud state (which
 * carries the internal branding) against the user's desired tags.
 */
export const stripInternalTags = (
  tags: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(([key]) => !key.startsWith("alchemy::")),
  );

/**
 * Creates AWS-compatible tag filters for finding resources by alchemy tags.
 * Use with AWS describe APIs that accept Filter parameters.
 */
export const createAlchemyTagFilters = Effect.fn(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return [
    { Name: "tag:alchemy::stack", Values: [stack.name] },
    { Name: "tag:alchemy::stage", Values: [stage] },
    { Name: "tag:alchemy::id", Values: [id] },
  ];
});

/**
 * Checks if a resource has the expected alchemy tags for this app/stage/id.
 */
export const hasAlchemyTags = Effect.fn(function* (
  id: string,
  tags: Tags | undefined,
) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  const expectedTags = {
    "alchemy::stack": stack.name,
    "alchemy::stage": stage,
    "alchemy::id": id,
  };
  return hasTags(expectedTags, tags);
});

export const diffTags = (
  oldTags: Record<string, string>,
  newTags: Record<string, string>,
) => {
  const removed: string[] = [];
  const updated: { Key: string; Value: string }[] = [];
  const added: { Key: string; Value: string }[] = [];
  for (const key in oldTags) {
    if (!(key in newTags)) {
      removed.push(key);
    } else if (oldTags[key] !== newTags[key]) {
      updated.push({ Key: key, Value: newTags[key] });
    }
  }
  for (const key in newTags) {
    if (!(key in oldTags)) {
      added.push({ Key: key, Value: newTags[key] });
    } else if (oldTags[key] !== newTags[key]) {
      updated.push({ Key: key, Value: newTags[key] });
    }
  }
  return {
    added,
    removed,
    updated,
    upsert: [...added, ...updated].filter(
      (tag, index, self) => self.findIndex((t) => t.Key === tag.Key) === index,
    ),
  };
};
