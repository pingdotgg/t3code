import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  MAX_VIEW_DISPLAY_NAME_LENGTH,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  toResourceId,
} from "./ownership.ts";

export type AuthorizedViewSetProps = {
  /**
   * AuthorizedViewSet id (the `{authorized_view_set}` segment of
   * `projects/{project}/locations/{location}/authorizedViewSets/{authorized_view_set}`).
   * If omitted, a unique id is generated. Must match
   * `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`. Immutable — changing it replaces
   * the set.
   */
  authorizedViewSetId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the set.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 64 characters including Alchemy's ownership
   * marker). AuthorizedViewSets have no labels field, so ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  displayName?: string;
};

export type AuthorizedViewSet = Resource<
  "GCP.ContactCenterInsights.AuthorizedViewSet",
  AuthorizedViewSetProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/authorizedViewSets/{authorized_view_set}`. */
    name: string;
    /** AuthorizedViewSet id (last path segment). */
    authorizedViewSetId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights AuthorizedViewSet, a container for
 * AuthorizedView resources.
 *
 * AuthorizedViewSets have no labels field — Alchemy stamps ownership into
 * the display name. Location and id are immutable. Display name updates
 * in place.
 *
 * ### Creating an AuthorizedViewSet
 * **Example:** Generated id
 * ```typescript
 * const set = yield* GCP.ContactCenterInsights.AuthorizedViewSet("QaViews", {
 *   displayName: "qa-reviewers",
 * });
 * ```
 *
 * **Example:** Named set
 * ```typescript
 * const set = yield* GCP.ContactCenterInsights.AuthorizedViewSet("QaViews", {
 *   authorizedViewSetId: "qa-reviewers",
 *   displayName: "qa-reviewers",
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const AuthorizedViewSet = Resource<AuthorizedViewSet>(
  "GCP.ContactCenterInsights.AuthorizedViewSet",
);

export class AuthorizedViewSetNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.AuthorizedViewSetNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  authorizedViewSetId: string,
) =>
  `${locationParent(project, location)}/authorizedViewSets/${authorizedViewSetId}`;

const toAttrs = (
  set: cci.GoogleCloudContactcenterinsightsV1AuthorizedViewSet,
  project: string,
) => {
  const name = set.name ?? "";
  const parsed = parseOwnership(set.displayName);
  return {
    name,
    authorizedViewSetId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    createTime: set.createTime,
    updateTime: set.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsAuthorizedViewSets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsAuthorizedViewSets
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.authorizedViewSets ?? []),
      ),
      Stream.filter((set) => hasOwnershipMarker(set.displayName)),
      Stream.map((set) => toAttrs(set, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const AuthorizedViewSetProvider = () =>
  Provider.succeed(AuthorizedViewSet, {
    stables: [
      "name",
      "authorizedViewSetId",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId =
        olds?.authorizedViewSetId ?? output?.authorizedViewSetId;
      if (
        previousId !== undefined &&
        news.authorizedViewSetId !== undefined &&
        news.authorizedViewSetId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authorizedViewSetId = yield* toResourceId(
        id,
        olds?.authorizedViewSetId,
        output?.authorizedViewSetId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, authorizedViewSetId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = locationParent(env.project, location);
      const authorizedViewSetId = yield* toResourceId(
        id,
        news.authorizedViewSetId,
        output?.authorizedViewSetId,
      );
      const name = resourceName(env.project, location, authorizedViewSetId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_VIEW_DISPLAY_NAME_LENGTH,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsAuthorizedViewSets({
            parent,
            authorizedViewSetId,
            body: { displayName },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AuthorizedViewSetNotResolved({ name });
      }

      const currentName = current.name ?? name;
      if ((current.displayName ?? "") !== displayName) {
        current = yield* cci.patchProjectsLocationsAuthorizedViewSets({
          name: currentName,
          updateMask: "display_name",
          body: { name: currentName, displayName },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsAuthorizedViewSets({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
