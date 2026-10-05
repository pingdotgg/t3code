import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  FOLDER_DISPLAY_MAX,
  collectPages,
  isDeleteRequested,
  resolveParent,
  resourceNameFromOperation,
  sameHierarchyParent,
  waitForOperation,
  waitForCreate,
} from "./internal.ts";

export type FolderProps = {
  /**
   * User-visible display name. Unique among sibling folders. 1-30
   * characters, starting and ending with a letter or digit. If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * Parent `organizations/{org}` or `folders/{folder}`. Defaults to the
   * current project's parent. Changing parent moves the folder.
   */
  parent?: string;
};

export type Folder = Resource<
  "GCP.ResourceManager.Folder",
  FolderProps,
  {
    /** Resource name `folders/{folder_id}`. */
    name: string;
    /** User-visible display name as stored in Cloud Resource Manager. */
    displayName: string;
    /** Parent `organizations/{org}` or `folders/{folder}`. */
    parent: string;
    /** Lifecycle state (`ACTIVE` or `DELETE_REQUESTED`). */
    state: string | undefined;
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 time a delete was requested, if any. */
    deleteTime: string | undefined;
    /** Configured folder capabilities, if any. */
    configuredCapabilities: string[];
    /** Management project when app-management is enabled. */
    managementProject: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Resource Manager folder — a node in an organization's resource
 * hierarchy used to group projects and other folders.
 *
 * Folders have no labels, so a folder found without prior state is
 * reported as unowned and only taken over with `--adopt`. `displayName`
 * updates in place; changing `parent` moves the folder. Delete is a 30-day
 * soft-delete (`DELETE_REQUESTED`).
 *
 * ### Creating a Folder
 * **Example:** Generated display name under the current project's parent
 * ```typescript
 * const folder = yield* GCP.ResourceManager.Folder("Team", {});
 * ```
 *
 * **Example:** Explicit display name and parent
 * ```typescript
 * const folder = yield* GCP.ResourceManager.Folder("Team", {
 *   displayName: "platform",
 *   parent: "organizations/123456789",
 * });
 * ```
 *
 * ### Updating a Folder
 * **Example:** Rename
 * ```typescript
 * const folder = yield* GCP.ResourceManager.Folder("Team", {
 *   displayName: "platform-prod",
 * });
 * ```
 *
 * @resource
 * @category ResourceManager
 */
export const Folder = Resource<Folder>("GCP.ResourceManager.Folder");

export class FolderNotResolved extends Data.TaggedError(
  "GCP.ResourceManager.FolderNotResolved",
)<{
  name: string;
}> {}

export class FolderStillExists extends Data.TaggedError(
  "GCP.ResourceManager.FolderStillExists",
)<{
  name: string;
}> {}

const sanitizeDisplayName = (value: string) => {
  let next = value
    .replace(/[^a-zA-Z0-9_ \-]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (next.length > FOLDER_DISPLAY_MAX) {
    next = next.slice(0, FOLDER_DISPLAY_MAX);
  }
  if (!/^[a-zA-Z0-9]/.test(next))
    next = `a${next}`.slice(0, FOLDER_DISPLAY_MAX);
  next = next.replace(/[^a-zA-Z0-9]+$/g, "");
  if (next.length === 0) next = "az0";
  return next;
};

const toDisplayName = (
  id: string,
  displayName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (displayName !== undefined) return sanitizeDisplayName(displayName);
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: FOLDER_DISPLAY_MAX,
      lowercase: true,
      suffixLength: 8,
    });
    return sanitizeDisplayName(generated);
  });

const toAttrs = (folder: resourcemanager.Folder) => ({
  name: folder.name ?? "",
  displayName: folder.displayName ?? "",
  parent: folder.parent ?? "",
  state: folder.state,
  etag: folder.etag,
  createTime: folder.createTime,
  updateTime: folder.updateTime,
  deleteTime: folder.deleteTime,
  configuredCapabilities: folder.configuredCapabilities ?? [],
  managementProject: folder.managementProject,
});

const getByName = (name: string) =>
  resourcemanager
    .getFolders({ name })
    .pipe(
      Effect.catchTag(["NotFound", "FolderNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const listChildren = (parent: string, showDeleted = true) =>
  collectPages(
    resourcemanager.listFolders.pages({
      parent,
      pageSize: 300,
      showDeleted,
    }),
    (page) => page.folders,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as resourcemanager.Folder[]),
    ),
  );

const findByDisplayName = (
  parent: string,
  displayName: string,
  resourceName?: string,
) =>
  Effect.gen(function* () {
    if (resourceName !== undefined && resourceName.length > 0) {
      const byName = yield* getByName(resourceName);
      if (byName !== undefined) return byName;
    }
    const children = yield* listChildren(parent, true);
    return children.find((folder) => folder.displayName === displayName);
  });

const observe = (
  resourceName: string | undefined,
  parent: string,
  displayName: string,
) =>
  Effect.gen(function* () {
    if (resourceName !== undefined && resourceName.length > 0) {
      const byName = yield* getByName(resourceName);
      if (byName !== undefined) return byName;
    }
    return yield* findByDisplayName(parent, displayName, resourceName);
  });

const waitUntilExists = (
  resourceName: string | undefined,
  parent: string,
  displayName: string,
) =>
  observe(resourceName, parent, displayName).pipe(
    Effect.filterOrFail(
      (folder): folder is resourcemanager.Folder => folder !== undefined,
      () =>
        new FolderNotResolved({
          name: resourceName ?? `${parent}/${displayName}`,
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.FolderNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((folder) =>
      folder === undefined || isDeleteRequested(folder.state)
        ? Effect.void
        : Effect.fail(new FolderStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.FolderStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const ensureActive = (folder: resourcemanager.Folder) =>
  Effect.gen(function* () {
    if (!isDeleteRequested(folder.state) || folder.name === undefined) {
      return folder;
    }
    const operation = yield* resourcemanager.undeleteFolders({
      name: folder.name,
      body: {},
    });
    yield* waitForOperation(operation);
    return (
      (yield* waitUntilExists(
        folder.name,
        folder.parent ?? "",
        folder.displayName ?? "",
      )) ?? folder
    );
  });

export const FolderProvider = () =>
  Provider.succeed(Folder, {
    stables: ["name", "createTime"],

    read: Effect.fn(function* ({ id, olds, output }) {
      const displayName = yield* toDisplayName(
        id,
        olds?.displayName,
        output?.displayName,
      );
      const parent = yield* resolveParent(olds?.parent, output?.parent).pipe(
        Effect.catchTag("GCP.ResourceManager.ParentRequired", () =>
          Effect.succeed(output?.parent ?? ""),
        ),
      );
      if (parent.length === 0 && output?.name === undefined) return undefined;
      const existing = yield* observe(
        output?.name,
        parent || (output?.parent ?? ""),
        displayName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const parent = yield* resolveParent(news.parent, output?.parent);

      let current = yield* observe(output?.name, parent, displayName);

      if (current === undefined) {
        const created = yield* resourcemanager
          .createFolders({
            body: {
              parent,
              displayName,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const settled = yield* waitForCreate(created);
          current = yield* waitUntilExists(
            resourceNameFromOperation(settled, "folders/") ??
              resourceNameFromOperation(created, "folders/"),
            parent,
            displayName,
          );
        } else {
          current = yield* waitUntilExists(undefined, parent, displayName);
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new FolderNotResolved({
          name: output?.name ?? `${parent}/${displayName}`,
        });
      }

      const name = current.name;
      current = yield* ensureActive(current);

      if ((current.displayName ?? "") !== displayName) {
        const operation = yield* resourcemanager.patchFolders({
          name: current.name ?? name,
          updateMask: "displayName",
          body: {
            name: current.name ?? name,
            displayName,
            etag: current.etag,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          current.name ?? name,
          parent,
          displayName,
        );
      }

      if (
        current.parent !== undefined &&
        !sameHierarchyParent(current.parent, parent)
      ) {
        const operation = yield* resourcemanager.moveFolders({
          name: current.name ?? name,
          body: { destinationParent: parent },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          current.name ?? name,
          parent,
          displayName,
        );
      }

      if (current === undefined) {
        return yield* new FolderNotResolved({
          name: output?.name ?? `${parent}/${displayName}`,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* resourcemanager
        .deleteFolders({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag(["NotFound", "FolderNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
