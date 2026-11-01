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
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type ViewProps = {
  /**
   * View id (the `{view}` segment of
   * `projects/{project}/locations/{location}/views/{view}`). If omitted, a
   * unique id is generated. Immutable — changing it replaces the view.
   */
  viewId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * view. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 64 characters including Alchemy's ownership
   * marker). Views have no labels field, so ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  displayName?: string;
  /**
   * Filter reducing conversation results to a subset. See
   * https://cloud.google.com/contact-center/insights/docs/filtering.
   */
  value?: string;
};

export type View = Resource<
  "GCP.ContactCenterInsights.View",
  ViewProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/views/{view}`. */
    name: string;
    /** View id (last path segment). */
    viewId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Conversation filter. */
    value: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights saved view — a named conversation filter.
 *
 * Views have no labels field — Alchemy stamps ownership into the display
 * name. Location and id are immutable. Display name and filter value
 * update in place.
 *
 * ### Creating a View
 * **Example:** Chat-only view
 * ```typescript
 * const view = yield* GCP.ContactCenterInsights.View("Chat", {
 *   displayName: "chat",
 *   value: 'medium="CHAT"',
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const View = Resource<View>("GCP.ContactCenterInsights.View");

export class ViewNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.ViewNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, viewId: string) =>
  `${locationParent(project, location)}/views/${viewId}`;

const toAttrs = (
  view: cci.GoogleCloudContactcenterinsightsV1View,
  project: string,
) => {
  const name = view.name ?? "";
  const parsed = parseOwnership(view.displayName);
  return {
    name,
    viewId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    value: view.value,
    createTime: view.createTime,
    updateTime: view.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsViews({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsViews.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.views ?? [])),
    Stream.filter((view) => hasOwnershipMarker(view.displayName)),
    Stream.map((view) => toAttrs(view, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

const findByDisplayName = (parent: string, displayName: string) =>
  cci.listProjectsLocationsViews.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.views ?? [])),
    Stream.filter((view) => view.displayName === displayName),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const ViewProvider = () =>
  Provider.succeed(View, {
    stables: ["name", "viewId", "location", "project", "createTime"],

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
      const previousId = olds?.viewId ?? output?.viewId;
      if (
        previousId !== undefined &&
        news.viewId !== undefined &&
        news.viewId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const viewId = yield* toResourceId(id, olds?.viewId, output?.viewId);
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, viewId);
      let existing = yield* getByName(name);
      if (existing === undefined && output?.name === undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          locationParent(env.project, location),
          encodeOwnershipLine(
            ownership,
            olds?.displayName,
            MAX_VIEW_DISPLAY_NAME_LENGTH,
          ),
        );
      }
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
      const viewId = yield* toResourceId(id, news.viewId, output?.viewId);
      const name = output?.name ?? resourceName(env.project, location, viewId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_VIEW_DISPLAY_NAME_LENGTH,
      );

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsViews({
            parent,
            body: {
              name,
              displayName,
              value: news.value,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? (yield* findByDisplayName(parent, displayName));
      }

      if (current === undefined) {
        return yield* new ViewNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const valueChanged = !sameText(current.value, news.value);

      if (displayChanged || valueChanged) {
        current = yield* cci.patchProjectsLocationsViews({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            valueChanged ? "value" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            value: news.value,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsViews({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
