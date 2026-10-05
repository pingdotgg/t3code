import * as ces from "@distilled.cloud/gcp/ces_v1";
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
  collectPages,
  encodeOwnership,
  expandApp,
  forEachApp,
  hasOwnershipMarker,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";

export type AppsVersionProps = {
  /**
   * Parent CES app. Full name
   * `projects/{project}/locations/{location}/apps/{app}` or the app id
   * (combined with `location`). Immutable — changing it replaces the
   * version.
   */
  app: string;
  /**
   * Region used when `app` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * App version id. If omitted, a unique name is generated. Immutable —
   * changing it replaces the version.
   */
  appVersionId?: string;
  /**
   * Human-readable name. Alchemy falls back to the generated version
   * id.
   */
  displayName?: string;
  /**
   * Snapshot description. Versions have no labels field and no update
   * RPC, so Alchemy stamps ownership into this field at create time.
   * Later description edits are ignored.
   */
  description?: string;
};

export type AppsVersion = Resource<
  "GCP.CES.AppsVersion",
  AppsVersionProps,
  {
    /** Full resource name `.../apps/{app}/versions/{version}`. */
    name: string;
    /** Version id (last path segment). */
    appVersionId: string;
    /** Parent app resource name. */
    app: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Email of the user who created the version. */
    creator: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Server-assigned etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Customer Engagement Suite app version — an immutable snapshot of an
 * app at a point in time.
 *
 * Versions have no labels field and no patch RPC. Alchemy stamps
 * ownership into `description` so `list` / nuke can find them. Reconcile
 * is observe-ensure: if the snapshot is missing it is created; later
 * description edits are ignored.
 *
 * ### Creating an App Version
 * **Example:** Snapshot
 * ```typescript
 * const version = yield* GCP.CES.AppsVersion("v1", {
 *   app: app.name,
 *   displayName: "v1",
 *   description: "initial",
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const AppsVersion = Resource<AppsVersion>("GCP.CES.AppsVersion");

export class AppsVersionNotResolved extends Data.TaggedError(
  "GCP.CES.AppsVersionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (app: string, appVersionId: string) =>
  `${app}/versions/${appVersionId}`;

const toAttrs = (
  version: ces.AppVersion,
  project: string,
  region: string,
  appHint?: string,
) => {
  const name = version.name ?? "";
  const parsed = parseResourceName(name, "versions", region);
  return {
    name,
    appVersionId: parsed.id,
    app: name.includes("/versions/") ? parsed.app : (appHint ?? parsed.parent),
    location: parsed.location,
    project: parsed.project || project,
    displayName: version.displayName,
    description: parseOwnership(version.description).text,
    creator: version.creator,
    createTime: version.createTime,
    etag: version.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsAppsVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  collectPages(
    ces.listProjectsLocationsAppsVersions.pages({ parent, pageSize: 100 }),
    (page) => page.appVersions,
  ).pipe(
    Effect.map((versions) =>
      versions
        .filter((version) => hasOwnershipMarker(version.description))
        .map((version) => toAttrs(version, project, region, parent)),
    ),
  );

export const AppsVersionProvider = () =>
  Provider.succeed(AppsVersion, {
    stables: [
      "name",
      "appVersionId",
      "app",
      "location",
      "project",
      "createTime",
      "creator",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.appVersionId ?? output?.appVersionId,
        nextId: news.appVersionId,
        previousParent: olds?.app ?? output?.app,
        nextParent: news.app,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const app = olds?.app
        ? expandApp(olds.app, env.project, location)
        : output?.app;
      const appVersionId = yield* toPhysicalId(
        id,
        olds?.appVersionId,
        output?.appVersionId,
      );
      const name =
        output?.name ??
        (app !== undefined ? resourceName(app, appVersionId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, app);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* forEachApp(
          env.project,
          (parent) => listAt(parent, env.project, env.region),
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const app = expandApp(news.app, env.project, location);
      const appVersionId = yield* toPhysicalId(
        id,
        news.appVersionId,
        output?.appVersionId,
      );
      const name = output?.name ?? resourceName(app, appVersionId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? appVersionId;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsAppsVersions({
            parent: app,
            appVersionId,
            body: {
              displayName,
              description,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsVersionNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        ces.deleteProjectsLocationsAppsVersions({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
