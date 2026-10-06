import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitForCreate, waitForOperation } from "./internal.ts";

const MAX_NAME_LENGTH = 63;
export type TagValueProps = {
  /**
   * Parent TagKey resource name (`tagKeys/{tagKey}`). Immutable —
   * changing it replaces the TagValue.
   */
  parent: string;
  /**
   * User-assigned short name, unique among TagValues of the same TagKey.
   * 1–256 characters, beginning and ending with `[a-zA-Z0-9]`, with
   * dashes, underscores, dots, and alphanumerics between. If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the TagValue.
   */
  shortName?: string;
  /**
   * Human-readable description (max 256 characters).
   */
  description?: string;
};

export type TagValue = Resource<
  "GCP.ResourceManager.TagValue",
  TagValueProps,
  {
    /** Resource name `tagValues/{tagValue}`. */
    name: string;
    /** Parent TagKey name `tagKeys/{tagKey}`. */
    parent: string;
    /** User-assigned short name. */
    shortName: string;
    /**
     * Namespaced name `{project}/{tagKeyShort}/{tagValueShort}` (or the
     * organization-id form).
     */
    namespacedName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Project id of the deploying stack. */
    project: string;
    /** Optimistic-concurrency etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Resource Manager TagValue — a child of a TagKey used to group
 * resources for policy.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * `parent` and `shortName` are identity — changing either replaces the value.
 * Description updates in place. Create, update, and delete are long-running
 * operations polled via `getOperations`.
 *
 * ### Creating a TagValue
 * **Example:** Generated short name under a TagKey
 * ```typescript
 * const key = yield* GCP.ResourceManager.TagKey("Environment", {});
 * const value = yield* GCP.ResourceManager.TagValue("Prod", {
 *   parent: key.name,
 *   description: "production",
 * });
 * ```
 *
 * **Example:** Explicit short name
 * ```typescript
 * const value = yield* GCP.ResourceManager.TagValue("Prod", {
 *   parent: "tagKeys/123456789012",
 *   shortName: "prod",
 *   description: "production",
 * });
 * ```
 *
 * ### Updating a TagValue
 * **Example:** Change the description
 * ```typescript
 * const value = yield* GCP.ResourceManager.TagValue("Prod", {
 *   parent: "tagKeys/123456789012",
 *   shortName: "prod",
 *   description: "production workloads",
 * });
 * ```
 *
 * @resource
 * @category ResourceManager
 */
export const TagValue = Resource<TagValue>("GCP.ResourceManager.TagValue");

export class TagValueNotResolved extends Data.TaggedError(
  "GCP.ResourceManager.TagValueNotResolved",
)<{
  name: string;
}> {}

export class TagValueParentRequired extends Data.TaggedError(
  "GCP.ResourceManager.TagValueParentRequired",
)<{
  parent: string;
}> {}

export class TagValueStillExists extends Data.TaggedError(
  "GCP.ResourceManager.TagValueStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeParent = (parent: string): string => {
  const trimmed = parent.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("tagKeys/")) return trimmed;
  if (/^\d+$/.test(trimmed)) return `tagKeys/${trimmed}`;
  return trimmed;
};

const toShortName = (
  id: string,
  shortName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (shortName !== undefined) return shortName;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const named = /^[a-z]/.test(generated) ? generated : `t${generated}`;
    return named.replace(/-+$/g, "").slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (
  value: crm.TagValue,
  project: string,
): TagValue["Attributes"] => {
  return {
    name: value.name ?? "",
    parent: value.parent ?? "",
    shortName: value.shortName ?? lastSegment(value.namespacedName ?? ""),
    namespacedName: value.namespacedName,
    description: value.description,
    project,
    etag: value.etag,
    createTime: value.createTime,
    updateTime: value.updateTime,
  };
};

const getByName = (name: string) =>
  crm
    .getTagValues({ name })
    .pipe(
      Effect.catchTag(["NotFound", "TagValueNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const listTagValuesUnder = (parent: string) =>
  crm.listTagValues.pages({ parent, pageSize: 300 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.tagValues ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    // The parent TagKey is gone: it has no values.
    Effect.catchTag(["NotFound", "TagValueNotFound"], () =>
      Effect.succeed([] as crm.TagValue[]),
    ),
  );

const findByParentAndShortName = (parent: string, shortName: string) =>
  listTagValuesUnder(parent).pipe(
    Effect.map((values) =>
      values.find((value) => value.shortName === shortName),
    ),
  );

const observe = (
  name: string | undefined,
  parent: string | undefined,
  shortName: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    if (parent !== undefined && parent.length > 0) {
      return yield* findByParentAndShortName(parent, shortName);
    }
    return undefined;
  });

const nameFromOperation = (operation: crm.Operation): string | undefined => {
  const name = operation.response?.name;
  return typeof name === "string" && name.startsWith("tagValues/")
    ? name
    : undefined;
};

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new TagValueNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagValueNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilFound = (parent: string, shortName: string) =>
  findByParentAndShortName(parent, shortName).pipe(
    Effect.flatMap((value) =>
      value !== undefined
        ? Effect.succeed(value)
        : Effect.fail(
            new TagValueNotResolved({ name: `${parent}/${shortName}` }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagValueNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new TagValueStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagValueStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.ResourceManager.TagValueStillExists",
      () => Effect.void,
    ),
  );

const requireParent = (parent: string) => {
  const normalized = normalizeParent(parent);
  if (!normalized.startsWith("tagKeys/") || lastSegment(normalized) === "") {
    return Effect.fail(new TagValueParentRequired({ parent }));
  }
  return Effect.succeed(normalized);
};

export const TagValueProvider = () =>
  Provider.succeed(TagValue, {
    stables: [
      "name",
      "parent",
      "shortName",
      "namespacedName",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = news.parent ?? previousParent;
      const parentChanged =
        previousParent !== undefined &&
        nextParent !== undefined &&
        normalizeParent(previousParent) !== normalizeParent(nextParent);

      const previousShort = olds?.shortName ?? output?.shortName;
      const nextShort = news.shortName ?? previousShort;
      const shortChanged =
        previousShort !== undefined &&
        nextShort !== undefined &&
        nextShort !== previousShort;

      if (parentChanged || shortChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent =
        olds?.parent !== undefined
          ? normalizeParent(olds.parent)
          : output?.parent;
      const shortName = yield* toShortName(
        id,
        olds?.shortName,
        output?.shortName,
      );
      const existing = yield* observe(output?.name, parent, shortName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = yield* requireParent(news.parent);
      const shortName = yield* toShortName(
        id,
        news.shortName,
        output?.shortName,
      );
      const desiredDescription = news.description;

      let current = yield* observe(output?.name, parent, shortName);

      if (current === undefined) {
        const operation = yield* crm
          .createTagValues({
            body: {
              parent,
              shortName,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          const done = yield* waitForCreate(operation);
          const createdName = nameFromOperation(done);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(createdName).pipe(
              Effect.catchTag("GCP.ResourceManager.TagValueNotResolved", () =>
                Effect.succeed(undefined),
              ),
            );
          }
        }
        if (current === undefined) {
          current = yield* waitUntilFound(parent, shortName);
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new TagValueNotResolved({
          name: `${parent}/${shortName}`,
        });
      }

      if ((current.description ?? "") !== (desiredDescription ?? "")) {
        const patched = yield* crm.patchTagValues({
          name: current.name,
          updateMask: "description",
          body: {
            name: current.name,
            description: desiredDescription,
            etag: current.etag,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(current.name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* crm
        .deleteTagValues({ name: output.name, etag: output.etag })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag(["NotFound", "TagValueNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
