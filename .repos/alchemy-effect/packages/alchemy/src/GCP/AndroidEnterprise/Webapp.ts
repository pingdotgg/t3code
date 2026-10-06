import * as androidenterprise from "@distilled.cloud/gcp/androidenterprise_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_DISPLAY_MODE,
  findOwnedWebapp,
  getWebapp,
  hasOwnershipMarker,
  jsonEqual,
  listOwnedWebapps,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  defaultTitle,
  toDisplayName,
} from "./internal.ts";

export type WebappProps = {
  /**
   * Play EMM enterprise id. Immutable — changing it replaces the web app.
   */
  enterpriseId: string;
  /**
   * Server-assigned web app id (`app:com.google.enterprise.webapp.…`).
   * Immutable — changing it replaces the web app.
   */
  webAppId?: string;
  /**
   * Title shown to users, as given. Defaults to a generated name.
   */
  title?: string;
  /**
   * Start URL loaded when the user opens the app. HTTP URLs require
   * `displayMode: "minimalUi"`.
   */
  startUrl: string;
  /**
   * Display mode (`minimalUi`, `standalone`, or `fullScreen`).
   * @default "standalone"
   */
  displayMode?: androidenterprise.WebAppDisplayModeEnum | (string & {});
  /**
   * Icons for the web app. PNG or JPEG, ideally 512x512, as base64url
   * `imageData`.
   */
  icons?: androidenterprise.WebAppIcon[];
  /**
   * Whether the app is published to managed Google Play.
   */
  isPublished?: boolean;
};

export type Webapp = Resource<
  "GCP.AndroidEnterprise.Webapp",
  WebappProps,
  {
    /** Server-assigned web app id. */
    webAppId: string;
    /** Play EMM enterprise id. */
    enterpriseId: string;
    /** Project id used when the web app was reconciled. */
    project: string;
    /** User-facing title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Start URL. */
    startUrl: string | undefined;
    /** Display mode. */
    displayMode: string | undefined;
    /** Whether the app is published. */
    isPublished: boolean | undefined;
    /** Current version code. */
    versionCode: string | undefined;
  },
  never,
  Providers
>;

/**
 * A managed Google Play web app (`webapps`).
 *
 * Web apps have no labels field and their title is shown to users, so
 * Alchemy tracks an app by its recorded id only (`list` finds apps from
 * older releases that carried a title marker). `enterpriseId` and `webAppId` are identity
 * — changing either replaces the app. Title, start URL, display mode,
 * icons, and publish state update in place.
 *
 * ### Creating a Web App
 * **Example:** Standalone HTTPS app
 * ```typescript
 * const app = yield* GCP.AndroidEnterprise.Webapp("Portal", {
 *   enterpriseId: "123456789",
 *   startUrl: "https://intranet.example.com/",
 *   title: "Portal",
 * });
 * ```
 *
 * **Example:** Minimal UI for an HTTP URL
 * ```typescript
 * const app = yield* GCP.AndroidEnterprise.Webapp("Legacy", {
 *   enterpriseId: "123456789",
 *   startUrl: "http://intranet.example.com/",
 *   displayMode: "minimalUi",
 *   title: "Legacy portal",
 * });
 * ```
 *
 * ### Updating a Web App
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename
 * ```typescript
 * const app = yield* GCP.AndroidEnterprise.Webapp("Portal", {
 *   enterpriseId: "123456789",
 *   startUrl: "https://intranet.example.com/",
 *   title: "Employee portal",
 * });
 * ```
 *
 * @resource
 * @category AndroidEnterprise
 */
export const Webapp = Resource<Webapp>("GCP.AndroidEnterprise.Webapp");

export class WebappNotResolved extends Data.TaggedError(
  "GCP.AndroidEnterprise.WebappNotResolved",
)<{
  enterpriseId: string;
  webAppId: string;
}> {}

const toAttrs = (
  webapp: androidenterprise.WebApp,
  enterpriseId: string,
  project: string,
) => ({
  webAppId: webapp.webAppId ?? "",
  enterpriseId,
  project,
  title: parseOwnership(webapp.title).text,
  startUrl: webapp.startUrl,
  displayMode: webapp.displayMode,
  isPublished: webapp.isPublished,
  versionCode: webapp.versionCode,
});

const desiredBody = (input: {
  webAppId?: string;
  title: string;
  news: WebappProps;
  current?: androidenterprise.WebApp;
}): androidenterprise.WebApp => ({
  webAppId: input.webAppId,
  title: input.title,
  startUrl: input.news.startUrl,
  displayMode:
    input.news.displayMode ??
    input.current?.displayMode ??
    DEFAULT_DISPLAY_MODE,
  icons: input.news.icons ?? input.current?.icons,
  isPublished: input.news.isPublished ?? input.current?.isPublished,
});

const needsSync = (
  current: androidenterprise.WebApp,
  desired: androidenterprise.WebApp,
) =>
  !sameText(current.title, desired.title) ||
  !sameText(current.startUrl, desired.startUrl) ||
  (desired.displayMode !== undefined &&
    !sameText(current.displayMode, desired.displayMode)) ||
  (desired.icons !== undefined && !jsonEqual(current.icons, desired.icons)) ||
  (desired.isPublished !== undefined &&
    current.isPublished !== desired.isPublished);

export const WebappProvider = () =>
  Provider.succeed(Webapp, {
    stables: ["webAppId", "enterpriseId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEnterprise = olds?.enterpriseId ?? output?.enterpriseId;
      if (
        previousEnterprise !== undefined &&
        news.enterpriseId !== previousEnterprise
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.webAppId ?? output?.webAppId;
      if (
        previousId !== undefined &&
        news.webAppId !== undefined &&
        news.webAppId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const enterpriseId = olds?.enterpriseId ?? output?.enterpriseId ?? "";
      const webAppId = olds?.webAppId ?? output?.webAppId ?? "";
      let existing = yield* getWebapp(enterpriseId, webAppId);
      if (existing === undefined && enterpriseId.length > 0) {
        existing = yield* findOwnedWebapp(id, enterpriseId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, enterpriseId, env.project);
      // Only a recorded id (or a legacy ownership marker) proves ownership;
      // names and titles are user-visible and carry no marker.
      return output !== undefined || (yield* ownedByAlchemy(id, existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const webapps = yield* listOwnedWebapps();
        return webapps
          .filter(({ webapp }) => hasOwnershipMarker(webapp.title))
          .map(({ webapp, enterpriseId }) =>
            toAttrs(webapp, enterpriseId, env.project),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const enterpriseId = news.enterpriseId;
      const displayName = yield* toDisplayName(id, news.title, output?.title);
      const title = defaultTitle(news.title, displayName);

      let current = yield* getWebapp(
        enterpriseId,
        news.webAppId ?? output?.webAppId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedWebapp(id, enterpriseId);
      }

      if (current === undefined) {
        const created = yield* androidenterprise
          .insertWebapps({
            enterpriseId,
            body: desiredBody({ title, news }),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedWebapp(id, enterpriseId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new WebappNotResolved({
          enterpriseId,
          webAppId: news.webAppId ?? output?.webAppId ?? displayName,
        });
      }

      const webAppId =
        current.webAppId ?? news.webAppId ?? output?.webAppId ?? "";
      const desired = desiredBody({
        webAppId,
        title,
        news,
        current,
      });
      if (needsSync(current, desired)) {
        current = yield* androidenterprise.updateWebapps({
          enterpriseId,
          webAppId,
          body: desired,
        });
      }

      return toAttrs(current, enterpriseId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.enterpriseId || !output.webAppId) return;
      yield* androidenterprise
        .deleteWebapps({
          enterpriseId: output.enterpriseId,
          webAppId: output.webAppId,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }),
  });
