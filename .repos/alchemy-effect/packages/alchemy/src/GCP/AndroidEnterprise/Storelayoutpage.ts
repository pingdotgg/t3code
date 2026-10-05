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
  findOwnedPage,
  getPage,
  hasOwnershipMarker,
  jsonEqual,
  listOwnedPages,
  ownedByAlchemy,
  ownershipTextFromNames,
  publicNames,
  sameStringList,
  defaultNames,
  toDisplayName,
} from "./internal.ts";

export type StorelayoutpageProps = {
  /**
   * Play EMM enterprise id. Immutable — changing it replaces the page.
   */
  enterpriseId: string;
  /**
   * Server-assigned store page id. Immutable — changing it replaces the
   * page.
   */
  pageId?: string;
  /**
   * Localized page names, shown to device users as given.
   */
  name?: androidenterprise.LocalizedText[];
  /**
   * Page ids a user can reach from this page. The list cannot include
   * this page.
   */
  link?: string[];
};

export type Storelayoutpage = Resource<
  "GCP.AndroidEnterprise.Storelayoutpage",
  StorelayoutpageProps,
  {
    /** Server-assigned store page id. */
    pageId: string;
    /** Play EMM enterprise id. */
    enterpriseId: string;
    /** Project id used when the page was reconciled. */
    project: string;
    /** Localized names with the Alchemy ownership prefix stripped. */
    name: androidenterprise.LocalizedText[] | undefined;
    /** Linked page ids. */
    link: string[] | undefined;
  },
  never,
  Providers
>;

/**
 * A managed Google Play store page (`storelayoutpages`).
 *
 * Store pages have no labels field and their names are shown to device
 * users, so Alchemy tracks a page by its recorded id only (`list` finds
 * pages from older releases that carried a name marker). `enterpriseId` and `pageId`
 * are identity — changing either replaces the page. Names and links
 * update in place.
 *
 * ### Creating a Store Page
 * **Example:** Generated name
 * ```typescript
 * const page = yield* GCP.AndroidEnterprise.Storelayoutpage("Home", {
 *   enterpriseId: "123456789",
 * });
 * ```
 *
 * **Example:** Explicit localized name
 * ```typescript
 * const page = yield* GCP.AndroidEnterprise.Storelayoutpage("Home", {
 *   enterpriseId: "123456789",
 *   name: [{ locale: "en-US", text: "Home" }],
 * });
 * ```
 *
 * ### Updating a Store Page
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename
 * ```typescript
 * const page = yield* GCP.AndroidEnterprise.Storelayoutpage("Home", {
 *   enterpriseId: "123456789",
 *   name: [{ locale: "en-US", text: "Featured" }],
 * });
 * ```
 *
 * @resource
 * @category AndroidEnterprise
 */
export const Storelayoutpage = Resource<Storelayoutpage>(
  "GCP.AndroidEnterprise.Storelayoutpage",
);

export class StorelayoutpageNotResolved extends Data.TaggedError(
  "GCP.AndroidEnterprise.StorelayoutpageNotResolved",
)<{
  enterpriseId: string;
  pageId: string;
}> {}

const toAttrs = (
  page: androidenterprise.StorePage,
  enterpriseId: string,
  project: string,
) => ({
  pageId: page.id ?? "",
  enterpriseId,
  project,
  name: publicNames(page.name),
  link: page.link,
});

const desiredBody = (input: {
  pageId?: string;
  name: androidenterprise.LocalizedText[];
  news: StorelayoutpageProps;
  current?: androidenterprise.StorePage;
}): androidenterprise.StorePage => ({
  id: input.pageId,
  name: input.name,
  link: input.news.link ?? input.current?.link,
});

const needsSync = (
  current: androidenterprise.StorePage,
  desired: androidenterprise.StorePage,
) =>
  !jsonEqual(current.name, desired.name) ||
  (desired.link !== undefined && !sameStringList(current.link, desired.link));

export const StorelayoutpageProvider = () =>
  Provider.succeed(Storelayoutpage, {
    stables: ["pageId", "enterpriseId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEnterprise = olds?.enterpriseId ?? output?.enterpriseId;
      if (
        previousEnterprise !== undefined &&
        news.enterpriseId !== previousEnterprise
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.pageId ?? output?.pageId;
      if (
        previousId !== undefined &&
        news.pageId !== undefined &&
        news.pageId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const enterpriseId = olds?.enterpriseId ?? output?.enterpriseId ?? "";
      const pageId = olds?.pageId ?? output?.pageId ?? "";
      let existing = yield* getPage(enterpriseId, pageId);
      if (existing === undefined && enterpriseId.length > 0) {
        existing = yield* findOwnedPage(id, enterpriseId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, enterpriseId, env.project);
      // Only a recorded id (or a legacy ownership marker) proves ownership;
      // names and titles are user-visible and carry no marker.
      return output !== undefined ||
        (yield* ownedByAlchemy(id, ownershipTextFromNames(existing.name)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* listOwnedPages();
        return pages
          .filter(({ page }) =>
            hasOwnershipMarker(ownershipTextFromNames(page.name)),
          )
          .map(({ page, enterpriseId }) =>
            toAttrs(page, enterpriseId, env.project),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const enterpriseId = news.enterpriseId;
      const displayName = yield* toDisplayName(
        id,
        news.name?.[0]?.text,
        output?.name?.[0]?.text,
      );
      const name = defaultNames(news.name, displayName);

      let current = yield* getPage(
        enterpriseId,
        news.pageId ?? output?.pageId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedPage(id, enterpriseId);
      }

      if (current === undefined) {
        const created = yield* androidenterprise
          .insertStorelayoutpages({
            enterpriseId,
            body: desiredBody({ name, news }),
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedPage(id, enterpriseId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new StorelayoutpageNotResolved({
          enterpriseId,
          pageId: news.pageId ?? output?.pageId ?? displayName,
        });
      }

      const pageId = current.id ?? news.pageId ?? output?.pageId ?? "";
      const desired = desiredBody({
        pageId,
        name,
        news,
        current,
      });
      if (needsSync(current, desired)) {
        current = yield* androidenterprise.updateStorelayoutpages({
          enterpriseId,
          pageId,
          body: desired,
        });
      }

      return toAttrs(current, enterpriseId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.enterpriseId || !output.pageId) return;
      yield* androidenterprise
        .deleteStorelayoutpages({
          enterpriseId: output.enterpriseId,
          pageId: output.pageId,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }),
  });
