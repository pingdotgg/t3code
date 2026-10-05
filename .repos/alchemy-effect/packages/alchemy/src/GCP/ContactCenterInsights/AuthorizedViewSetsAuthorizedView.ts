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
  parentOf,
  parseOwnership,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type AuthorizedViewSetsAuthorizedViewProps = {
  /**
   * Parent AuthorizedViewSet resource name
   * (`projects/{project}/locations/{location}/authorizedViewSets/{authorized_view_set}`).
   * Immutable — changing it replaces the view.
   */
  parent: string;
  /**
   * AuthorizedView id (the `{authorized_view}` segment). If omitted, a
   * unique id is generated. Must match
   * `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`. Immutable — changing it replaces
   * the view.
   */
  authorizedViewId?: string;
  /**
   * Display name (max 64 characters including Alchemy's ownership
   * marker, which takes at least 55). AuthorizedViews have no labels
   * field, so ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes; longer names are truncated.
   */
  displayName?: string;
  /**
   * Filter restricting which conversations this view can access. Empty
   * means no restriction.
   */
  conversationFilter?: string;
};

export type AuthorizedViewSetsAuthorizedView = Resource<
  "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedView",
  AuthorizedViewSetsAuthorizedViewProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/authorizedViewSets/{set}/authorizedViews/{view}`. */
    name: string;
    /** AuthorizedView id (last path segment). */
    authorizedViewId: string;
    /** Parent AuthorizedViewSet resource name. */
    parent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Conversation filter. */
    conversationFilter: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights AuthorizedView, a filtered view of
 * conversations and related Insights resources.
 *
 * AuthorizedViews have no labels field — Alchemy stamps ownership into
 * the display name. Parent set and id are immutable. Display name and
 * conversation filter update in place.
 *
 * ### Creating an AuthorizedView
 * **Example:** View under a set
 * ```typescript
 * const view = yield* GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedView(
 *   "Reviewers",
 *   {
 *     parent: set.name,
 *     displayName: "reviewers",
 *     conversationFilter: 'language_code="en-US"',
 *   },
 * );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const AuthorizedViewSetsAuthorizedView =
  Resource<AuthorizedViewSetsAuthorizedView>(
    "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedView",
  );

export class AuthorizedViewSetsAuthorizedViewNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, authorizedViewId: string) =>
  `${parent}/authorizedViews/${authorizedViewId}`;

const toAttrs = (
  view: cci.GoogleCloudContactcenterinsightsV1AuthorizedView,
  project: string,
) => {
  const name = view.name ?? "";
  const parsed = parseOwnership(view.displayName);
  return {
    name,
    authorizedViewId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    conversationFilter: view.conversationFilter,
    createTime: view.createTime,
    updateTime: view.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsAuthorizedViewSetsAuthorizedViews({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string, project: string) =>
  cci.listProjectsLocationsAuthorizedViewSetsAuthorizedViews
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.authorizedViews ?? [])),
      Stream.filter((view) => hasOwnershipMarker(view.displayName)),
      Stream.map((view) => toAttrs(view, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const AuthorizedViewSetsAuthorizedViewProvider = () =>
  Provider.succeed(AuthorizedViewSetsAuthorizedView, {
    stables: [
      "name",
      "authorizedViewId",
      "parent",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.authorizedViewId ?? output?.authorizedViewId;
      if (
        previousId !== undefined &&
        news.authorizedViewId !== undefined &&
        news.authorizedViewId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authorizedViewId = yield* toResourceId(
        id,
        olds?.authorizedViewId,
        output?.authorizedViewId,
      );
      const name =
        output?.name ??
        (olds?.parent !== undefined
          ? resourceName(olds.parent, authorizedViewId)
          : "");
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
        const parent = `${locationParent(env.project, env.region)}/authorizedViewSets/-`;
        return yield* listAtParent(parent, env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const authorizedViewId = yield* toResourceId(
        id,
        news.authorizedViewId,
        output?.authorizedViewId,
      );
      const name = resourceName(news.parent, authorizedViewId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_VIEW_DISPLAY_NAME_LENGTH,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsAuthorizedViewSetsAuthorizedViews({
            parent: news.parent,
            authorizedViewId,
            body: {
              displayName,
              conversationFilter: news.conversationFilter,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AuthorizedViewSetsAuthorizedViewNotResolved({
          name,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const filterChanged = !sameText(
        current.conversationFilter,
        news.conversationFilter,
      );

      if (displayChanged || filterChanged) {
        current =
          yield* cci.patchProjectsLocationsAuthorizedViewSetsAuthorizedViews({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              filterChanged ? "conversation_filter" : undefined,
            ),
            body: {
              name: currentName,
              displayName,
              conversationFilter: news.conversationFilter,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsAuthorizedViewSetsAuthorizedViews({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
