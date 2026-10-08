import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteFolderTree,
  encodeOwnershipLine,
  expandParent,
  hasOwnershipMarker,
  listFolders,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameText,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type ProjectsLocationsFolderProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * folder. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. Dataform folders have no labels field,
   * so Alchemy stamps ownership into a `[alchemy …]` prefix and strips
   * it from attributes. If omitted, only the ownership marker is stored.
   */
  displayName?: string;
  /**
   * Parent folder or team folder
   * (`projects/{project}/locations/{location}/folders/{folder}` or
   * `.../teamFolders/{teamFolder}`). Empty or omitted creates a root
   * user folder. Changing it moves the folder.
   */
  containingFolder?: string;
};

export type ProjectsLocationsFolder = Resource<
  "GCP.Dataform.ProjectsLocationsFolder",
  ProjectsLocationsFolderProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/folders/{folder}`. */
    name: string;
    /** Folder id (last path segment). */
    folderId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Parent folder or team folder, if any. */
    containingFolder: string | undefined;
    /** Associated team folder, if any. */
    teamFolderName: string | undefined;
    /** Creator IAM principal. */
    creatorIamPrincipal: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataform folder used to organize repositories and nested folders.
 *
 * Folders have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Location is immutable. Display name
 * updates in place; `containingFolder` is applied with MoveFolder.
 *
 * ### Creating a Folder
 * **Example:** Root folder
 * ```typescript
 * const folder = yield* GCP.Dataform.ProjectsLocationsFolder("Analytics", {
 *   displayName: "analytics",
 * });
 * ```
 *
 * **Example:** Nested folder
 * ```typescript
 * const child = yield* GCP.Dataform.ProjectsLocationsFolder("Models", {
 *   displayName: "models",
 *   containingFolder: folder.name,
 * });
 * ```
 *
 * @resource
 * @category Dataform
 */
export const ProjectsLocationsFolder = Resource<ProjectsLocationsFolder>(
  "GCP.Dataform.ProjectsLocationsFolder",
);

export class ProjectsLocationsFolderNotResolved extends Data.TaggedError(
  "GCP.Dataform.ProjectsLocationsFolderNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (folder: dataform.Folder, project: string, region: string) => {
  const name = folder.name ?? "";
  const parsed = parseResourceName(name, "folders", region);
  return {
    name,
    folderId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: parseOwnership(folder.displayName).text,
    containingFolder: folder.containingFolder,
    teamFolderName: folder.teamFolderName,
    creatorIamPrincipal: folder.creatorIamPrincipal,
    createTime: folder.createTime,
    updateTime: folder.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataform
        .getProjectsLocationsFolders({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  project: string,
  location: string,
  id: string,
  displayName: string | undefined,
) =>
  Effect.gen(function* () {
    const folders = yield* listFolders(project, location);
    for (const folder of folders) {
      if (yield* ownedByAlchemy(id, folder.displayName)) return folder;
    }
    if (displayName !== undefined) {
      const match = folders.find(
        (folder) => parseOwnership(folder.displayName).text === displayName,
      );
      if (match) return match;
    }
    return undefined;
  });

export const ProjectsLocationsFolderProvider = () =>
  Provider.succeed(ProjectsLocationsFolder, {
    stables: ["name", "folderId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const existing = output?.name
        ? yield* getByName(output.name)
        : yield* findOwned(env.project, location, id, olds?.displayName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const folders = yield* listFolders(env.project, env.region);
        return folders
          .filter((folder) => hasOwnershipMarker(folder.displayName))
          .map((folder) => toAttrs(folder, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const containingFolder =
        news.containingFolder !== undefined && news.containingFolder.length > 0
          ? news.containingFolder.includes("/")
            ? news.containingFolder
            : expandParent(
                news.containingFolder,
                env.project,
                location,
                "folders",
              )
          : undefined;

      let current = output?.name
        ? yield* getByName(output.name)
        : yield* findOwned(env.project, location, id, news.displayName);

      if (current === undefined) {
        const created = yield* retryTransient(
          dataform.createProjectsLocationsFolders({
            parent: locationParent(env.project, location),
            body: {
              displayName,
              containingFolder,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () =>
            findOwned(env.project, location, id, news.displayName),
          ),
        );
        current = created ?? undefined;
        if (current?.name) {
          current = (yield* getByName(current.name)) ?? current;
        }
      }

      if (current === undefined) {
        return yield* new ProjectsLocationsFolderNotResolved({
          name: output?.name ?? locationParent(env.project, location),
        });
      }

      const currentName = current.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      if (displayChanged) {
        current = yield* retryTransient(
          dataform.patchProjectsLocationsFolders({
            name: currentName,
            updateMask: updateMaskOf("displayName"),
            body: { displayName },
          }),
        );
      }

      const observedFolder = current.containingFolder ?? "";
      const desiredFolder = containingFolder ?? "";
      if (desiredFolder !== observedFolder) {
        yield* retryTransient(
          dataform.moveProjectsLocationsFolders({
            name: currentName,
            body: { destinationContainingFolder: desiredFolder },
          }),
        );
        current = (yield* getByName(currentName)) ?? current;
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(deleteFolderTree(output.name));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
