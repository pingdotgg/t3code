import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitForCreate, waitForOperation } from "./internal.ts";

const MAX_NAME_LENGTH = 63;
export type TagKeyPurpose =
  | "PURPOSE_UNSPECIFIED"
  | "GCE_FIREWALL"
  | "DATA_GOVERNANCE";

export type TagKeyProps = {
  /**
   * User-friendly short name. Unique among TagKeys under the same parent.
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-256 characters, begin and end with an
   * alphanumeric, and otherwise contain only letters, digits, dashes,
   * underscores, and dots. Immutable — changing it replaces the key.
   */
  shortName?: string;
  /**
   * Parent organization or project (`organizations/{org}` or
   * `projects/{project}`). Defaults to the stack's GCP project. Immutable
   * — changing it replaces the key.
   */
  parent?: string;
  /**
   * User-assigned description (max 256 characters).
   */
  description?: string;
  /**
   * Policy engine this key is intended for. Immutable — changing it
   * replaces the key.
   */
  purpose?: TagKeyPurpose | (string & {});
  /**
   * Purpose-specific metadata (for example `network` for `GCE_FIREWALL`).
   * Immutable — changing it replaces the key.
   */
  purposeData?: Record<string, string>;
  /**
   * Regular expression constraint for freeform TagValue short names.
   * Immutable — changing it replaces the key.
   */
  allowedValuesRegex?: string;
};

export type TagKey = Resource<
  "GCP.ResourceManager.TagKey",
  TagKeyProps,
  {
    /** Resource name `tagKeys/{tag_key_id}`. */
    name: string;
    /** User-friendly short name. */
    shortName: string;
    /** Namespaced name `{parentId}/{shortName}`. */
    namespacedName: string | undefined;
    /** Parent `organizations/{org}` or `projects/{project}`. */
    parent: string;
    /** Description. */
    description: string | undefined;
    /** Policy-engine purpose, if set. */
    purpose: string | undefined;
    /** Purpose-specific metadata. */
    purposeData: Record<string, string>;
    /** Freeform TagValue regex, if set. */
    allowedValuesRegex: string | undefined;
    /** Server etag for optimistic concurrency. */
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
 * A Resource Manager TagKey — a namespace for TagValues used to annotate
 * Google Cloud resources.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * TagKeys have no labels.
 *
 * `shortName`, `parent`, `purpose`, `purposeData`, and `allowedValuesRegex`
 * are immutable — changing them replaces the key. `description` is the only
 * updatable field.
 *
 * ### Creating a TagKey
 * **Example:** Generated short name
 * ```typescript
 * const env = yield* GCP.ResourceManager.TagKey("Environment", {});
 * ```
 *
 * **Example:** Explicit short name and description
 * ```typescript
 * const env = yield* GCP.ResourceManager.TagKey("Environment", {
 *   shortName: "environment",
 *   description: "deployment environment",
 *   parent: "projects/my-project",
 * });
 * ```
 *
 * ### Updating a TagKey
 * **Example:** Change description
 * ```typescript
 * const env = yield* GCP.ResourceManager.TagKey("Environment", {
 *   shortName: "environment",
 *   description: "prod vs staging",
 * });
 * ```
 *
 * @resource
 * @category ResourceManager
 */
export const TagKey = Resource<TagKey>("GCP.ResourceManager.TagKey");

export class TagKeyNotResolved extends Data.TaggedError(
  "GCP.ResourceManager.TagKeyNotResolved",
)<{
  name: string;
}> {}

export class TagKeyStillExists extends Data.TaggedError(
  "GCP.ResourceManager.TagKeyStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const defaultParent = (project: string) => `projects/${project}`;

const namespacedLookup = (parent: string, shortName: string) =>
  `${lastSegment(parent)}/${shortName}`;

const sameParent = (
  left: string | undefined,
  right: string | undefined,
  namespacedName?: string,
) => {
  if (left === undefined || right === undefined) return left === right;
  if (left === right) return true;
  const leftId = lastSegment(left);
  const rightId = lastSegment(right);
  if (leftId === rightId) return true;
  const ns = namespacedName?.split("/")[0];
  return ns !== undefined && (ns === leftId || ns === rightId);
};

const canonicalizePurpose = (purpose: string | undefined) =>
  !purpose || purpose === "PURPOSE_UNSPECIFIED" ? undefined : purpose;

const canonicalizeRegex = (value: string | undefined) =>
  value && value.length > 0 ? value : undefined;

const purposeDataJson = (
  data: Record<string, string | undefined> | null | undefined,
) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(data ?? {})
        .filter(([, value]) => value !== undefined && value.length > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );

const toId = (id: string, shortName: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (shortName !== undefined) return shortName;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z0-9]/.test(generated) && /[a-z0-9]$/.test(generated)
      ? generated
      : `k${generated}`.replace(/[^a-z0-9]+$/g, "").slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (key: resourcemanager.TagKey) => {
  return {
    name: key.name ?? "",
    shortName: key.shortName ?? "",
    namespacedName: key.namespacedName,
    parent: key.parent ?? "",
    description: key.description,
    purpose: canonicalizePurpose(key.purpose),
    purposeData: tagRecord(key.purposeData),
    allowedValuesRegex: canonicalizeRegex(key.allowedValuesRegex),
    etag: key.etag,
    createTime: key.createTime,
    updateTime: key.updateTime,
  };
};

const getByName = (name: string) =>
  resourcemanager
    .getTagKeys({ name })
    .pipe(
      Effect.catchTag(["NotFound", "TagKeyNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const getByNamespaced = (name: string) =>
  resourcemanager
    .getNamespacedTagKeys({ name })
    .pipe(
      Effect.catchTag(["NotFound", "TagKeyNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const observe = (resourceName: string | undefined, namespacedName: string) =>
  Effect.gen(function* () {
    if (resourceName !== undefined && resourceName.length > 0) {
      const byName = yield* getByName(resourceName);
      if (byName !== undefined) return byName;
    }
    return yield* getByNamespaced(namespacedName);
  });

const resourceNameFromOperation = (
  operation: resourcemanager.Operation,
): string | undefined => {
  const name = operation.response?.name;
  return typeof name === "string" && name.startsWith("tagKeys/")
    ? name
    : undefined;
};

const waitUntilExists = (
  resourceName: string | undefined,
  namespacedName: string,
) =>
  observe(resourceName, namespacedName).pipe(
    Effect.filterOrFail(
      (key): key is resourcemanager.TagKey => key !== undefined,
      () =>
        new TagKeyNotResolved({
          name: resourceName ?? namespacedName,
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.TagKeyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((key) =>
      key === undefined
        ? Effect.void
        : Effect.fail(new TagKeyStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.TagKeyStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toCreateBody = (
  parent: string,
  shortName: string,
  description: string | undefined,
  news: TagKeyProps,
): resourcemanager.TagKey => ({
  parent,
  shortName,
  description,
  purpose: canonicalizePurpose(news.purpose),
  purposeData:
    news.purposeData && Object.keys(news.purposeData).length > 0
      ? news.purposeData
      : undefined,
  allowedValuesRegex: canonicalizeRegex(news.allowedValuesRegex),
});

export const TagKeyProvider = () =>
  Provider.succeed(TagKey, {
    stables: [
      "name",
      "shortName",
      "namespacedName",
      "parent",
      "purpose",
      "purposeData",
      "allowedValuesRegex",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousShort = olds?.shortName ?? output?.shortName;
      const nextShort = news.shortName ?? previousShort;
      const shortChanged =
        previousShort !== undefined &&
        news.shortName !== undefined &&
        news.shortName !== previousShort;

      const previousParent = olds?.parent ?? output?.parent;
      const parentChanged =
        news.parent !== undefined &&
        previousParent !== undefined &&
        !sameParent(news.parent, previousParent, output?.namespacedName);

      const previousPurpose = canonicalizePurpose(
        olds?.purpose ?? output?.purpose,
      );
      const nextPurpose = canonicalizePurpose(news.purpose ?? previousPurpose);
      const purposeChanged = previousPurpose !== nextPurpose;

      const previousRegex = canonicalizeRegex(
        olds?.allowedValuesRegex ?? output?.allowedValuesRegex,
      );
      const nextRegex = canonicalizeRegex(
        news.allowedValuesRegex ?? previousRegex,
      );
      const regexChanged = previousRegex !== nextRegex;

      const previousData = purposeDataJson(
        olds?.purposeData ?? output?.purposeData,
      );
      const nextData = purposeDataJson(
        news.purposeData !== undefined
          ? news.purposeData
          : (olds?.purposeData ?? output?.purposeData),
      );
      const purposeDataChanged = previousData !== nextData;

      if (
        !shortChanged &&
        !parentChanged &&
        !purposeChanged &&
        !regexChanged &&
        !purposeDataChanged
      ) {
        return undefined;
      }

      const identitySame =
        nextShort === previousShort &&
        !parentChanged &&
        sameParent(
          news.parent ?? previousParent,
          previousParent,
          output?.namespacedName,
        );
      return {
        action: "replace" as const,
        deleteFirst: identitySame,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const shortName = yield* toId(id, olds?.shortName, output?.shortName);
      const parent =
        olds?.parent ?? output?.parent ?? defaultParent(env.project);
      const namespaced =
        output?.namespacedName ?? namespacedLookup(parent, shortName);
      const existing = yield* observe(output?.name, namespaced);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const shortName = yield* toId(id, news.shortName, output?.shortName);
      const parent =
        news.parent ?? output?.parent ?? defaultParent(env.project);
      const namespaced =
        output?.namespacedName ?? namespacedLookup(parent, shortName);
      const desiredDescription = news.description;

      let current = yield* observe(output?.name, namespaced);

      if (current === undefined) {
        const created = yield* resourcemanager
          .createTagKeys({
            body: toCreateBody(parent, shortName, desiredDescription, news),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const settled = yield* waitForCreate(created);
          current = yield* waitUntilExists(
            resourceNameFromOperation(settled) ??
              resourceNameFromOperation(created),
            namespaced,
          );
        } else {
          current = yield* waitUntilExists(undefined, namespaced);
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new TagKeyNotResolved({ name: namespaced });
      }

      const resourceName = current.name;
      if ((current.description ?? "") !== (desiredDescription ?? "")) {
        const operation = yield* resourcemanager.patchTagKeys({
          name: resourceName,
          updateMask: "description",
          body: {
            name: resourceName,
            description: desiredDescription,
            etag: current.etag,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(resourceName, namespaced);
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* resourcemanager
        .deleteTagKeys({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag(["NotFound", "TagKeyNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
