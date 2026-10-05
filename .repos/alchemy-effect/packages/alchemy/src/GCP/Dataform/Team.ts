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
  deleteTeamFolderTree,
  encodeOwnershipLine,
  hasOwnershipMarker,
  listTeamFolders,
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

export type TeamProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the team
   * folder. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. Required by the API. Team folders have no
   * labels field, so Alchemy stamps ownership into a `[alchemy …]`
   * prefix and strips it from attributes. If omitted, only the ownership
   * marker is stored.
   */
  displayName?: string;
};

export type Team = Resource<
  "GCP.Dataform.Team",
  TeamProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/teamFolders/{teamFolder}`. */
    name: string;
    /** Team folder id (last path segment). */
    teamFolderId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
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
 * A Dataform team folder — a project-level container for repositories
 * and folders with hierarchical access control.
 *
 * Team folders have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Location is immutable. Display name
 * updates in place.
 *
 * ### Creating a Team Folder
 * **Example:** Generated display name
 * ```typescript
 * const team = yield* GCP.Dataform.Team("Analytics", {});
 * ```
 *
 * **Example:** Named team folder
 * ```typescript
 * const team = yield* GCP.Dataform.Team("Analytics", {
 *   location: "us-central1",
 *   displayName: "analytics",
 * });
 * ```
 *
 * @resource
 * @category Dataform
 */
export const Team = Resource<Team>("GCP.Dataform.Team");

export class TeamNotResolved extends Data.TaggedError(
  "GCP.Dataform.TeamNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  folder: dataform.TeamFolder,
  project: string,
  region: string,
) => {
  const name = folder.name ?? "";
  const parsed = parseResourceName(name, "teamFolders", region);
  return {
    name,
    teamFolderId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: parseOwnership(folder.displayName).text,
    creatorIamPrincipal: folder.creatorIamPrincipal,
    createTime: folder.createTime,
    updateTime: folder.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataform
        .getProjectsLocationsTeamFolders({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  project: string,
  location: string,
  id: string,
  displayName: string | undefined,
) =>
  Effect.gen(function* () {
    const folders = yield* listTeamFolders(project, location);
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

export const TeamProvider = () =>
  Provider.succeed(Team, {
    stables: ["name", "teamFolderId", "project", "location", "createTime"],

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
        const folders = yield* listTeamFolders(env.project, env.region);
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

      let current = output?.name
        ? yield* getByName(output.name)
        : yield* findOwned(env.project, location, id, news.displayName);

      if (current === undefined) {
        const created = yield* retryTransient(
          dataform.createProjectsLocationsTeamFolders({
            parent: locationParent(env.project, location),
            body: { displayName },
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
        return yield* new TeamNotResolved({
          name: output?.name ?? locationParent(env.project, location),
        });
      }

      const currentName = current.name ?? "";
      if (!sameText(current.displayName, displayName)) {
        current = yield* retryTransient(
          dataform.patchProjectsLocationsTeamFolders({
            name: currentName,
            updateMask: updateMaskOf("displayName"),
            body: { displayName },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(deleteTeamFolderTree(output.name));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
