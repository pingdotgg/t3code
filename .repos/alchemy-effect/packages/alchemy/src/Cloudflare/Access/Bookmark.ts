import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as crypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type BookmarkProps = {
  /**
   * The name of the bookmark application shown in the App Launcher. Used as
   * a stable identifier so the provider can locate the bookmark during
   * adoption / state recovery. If omitted, a unique name is generated from
   * the stack/stage/logical id.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The domain the bookmark links to, e.g. `example.com` or
   * `wiki.example.com/path`.
   */
  domain: string;
  /**
   * The image URL for the logo shown in the App Launcher dashboard.
   */
  logoUrl?: string;
  /**
   * Whether to display the bookmark in the App Launcher.
   *
   * @default true
   */
  appLauncherVisible?: boolean;
};

export type Bookmark = Resource<
  "Cloudflare.Access.Bookmark",
  BookmarkProps,
  {
    /** UUID of the bookmark application. */
    bookmarkId: string;
    /** Cloudflare account that owns the bookmark. */
    accountId: string;
    /** Display name reported by Cloudflare. */
    name: string;
    /** The domain the bookmark links to. */
    domain: string;
    /** The logo URL shown in the App Launcher. */
    logoUrl: string | undefined;
    /** Whether the bookmark is displayed in the App Launcher. */
    appLauncherVisible: boolean;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Access bookmark application — an unprotected link
 * shown in the App Launcher.
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @deprecated **Legacy resource.** Cloudflare has deprecated the dedicated
 * bookmarks API in favor of Access applications with `type: "bookmark"` —
 * prefer {@link Application} for new configurations. This resource is
 * provided for managing pre-existing bookmark records.
 *
 * @section Creating a Bookmark
 * @example Basic bookmark
 * ```typescript
 * const bookmark = yield* Cloudflare.Access.Bookmark("Wiki", {
 *   domain: "wiki.example.com",
 * });
 * ```
 *
 * @example Bookmark with a logo, hidden from the App Launcher
 * ```typescript
 * const bookmark = yield* Cloudflare.Access.Bookmark("Wiki", {
 *   name: "internal-wiki",
 *   domain: "wiki.example.com",
 *   logoUrl: "https://example.com/logo.png",
 *   appLauncherVisible: false,
 * });
 * ```
 *
 * @section Preferred Alternative
 * @example Bookmark-type Access application (non-legacy)
 * ```typescript
 * const app = yield* Cloudflare.Access.Application("Wiki", {
 *   type: "bookmark",
 *   domain: "wiki.example.com",
 * });
 * ```
 */
export const Bookmark = Resource<Bookmark>("Cloudflare.Access.Bookmark");

export const isBookmark = (value: unknown): value is Bookmark =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Access.Bookmark";

export const BookmarkProvider = () =>
  Provider.succeed(Bookmark, {
    stables: ["bookmarkId", "accountId"],
    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // name/domain/logoUrl/appLauncherVisible converge via PUT.
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.bookmarkId) {
        const direct = yield* getBookmark(acct, output.bookmarkId);
        if (direct && direct.id) return toAttrs(direct, acct);
      }
      const name = yield* createBookmarkName(id, output?.name ?? olds?.name);
      const existing = yield* findBookmarkByName(acct, name);
      if (!existing || !existing.id) return undefined;
      return toAttrs(existing, acct);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const name = yield* createBookmarkName(id, news.name);
      const desiredVisible = news.appLauncherVisible ?? true;

      // Observe — prefer the cached id, fall back to a name lookup so we
      // recover from out-of-band deletes and state-persistence failures.
      let observed: ObservedBookmark | undefined;
      if (output?.bookmarkId) {
        observed = yield* getBookmark(acct, output.bookmarkId);
      }
      if (!observed || !observed.id) {
        observed = yield* findBookmarkByName(acct, name);
      }

      // Ensure — create when missing. The legacy API requires the new
      // bookmark's UUID in the path, so derive a deterministic one from the
      // name: a retry after a partial failure converges on the same record.
      if (!observed || !observed.id) {
        const bookmarkId = yield* deterministicUuid(`${acct}:${name}`);
        const created = yield* zeroTrust
          .createAccessBookmark({
            accountId: acct,
            bookmarkId,
            body: {
              name,
              domain: news.domain,
              logo_url: news.logoUrl,
              app_launcher_visible: desiredVisible,
            },
          })
          .pipe(
            Effect.catch((err) =>
              Effect.gen(function* () {
                const existing = yield* getBookmark(acct, bookmarkId);
                if (existing && existing.id) return existing;
                return yield* Effect.fail(err);
              }),
            ),
          );
        if (!created.id) {
          return yield* Effect.fail(
            new Error("Bookmark: created bookmark missing id"),
          );
        }
        return toAttrs(created, acct);
      }

      // Sync — PUT the full desired shape only on a real delta.
      if (
        observed.name !== name ||
        observed.domain !== news.domain ||
        (observed.logoUrl ?? undefined) !== news.logoUrl ||
        (observed.appLauncherVisible ?? true) !== desiredVisible
      ) {
        const updated = yield* zeroTrust.updateAccessBookmark({
          accountId: acct,
          bookmarkId: observed.id,
          body: {
            name,
            domain: news.domain,
            logo_url: news.logoUrl,
            app_launcher_visible: desiredVisible,
          },
        });
        observed = {
          id: updated.id ?? observed.id,
          name: updated.name ?? name,
          domain: updated.domain ?? news.domain,
          logoUrl: updated.logoUrl ?? news.logoUrl,
          appLauncherVisible: updated.appLauncherVisible ?? desiredVisible,
        };
      }

      return toAttrs(observed, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteAccessBookmark({
          accountId: output.accountId,
          bookmarkId: output.bookmarkId,
        })
        .pipe(Effect.catchTag("AccessBookmarkNotFound", () => Effect.void));
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listAccessBookmarks.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter((b): b is ObservedBookmark & { id: string } =>
                Predicate.isNotNullish(b.id),
              )
              .map((b) => toAttrs(b, accountId)),
          ),
        ),
      );
    }),
  });

const createBookmarkName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id });
  });

const getBookmark = (acct: string, bookmarkId: string) =>
  zeroTrust
    .getAccessBookmark({ accountId: acct, bookmarkId })
    .pipe(
      Effect.catchTag("AccessBookmarkNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

const findBookmarkByName = (acct: string, name: string) =>
  zeroTrust.listAccessBookmarks.items({ accountId: acct }).pipe(
    Stream.filter((b): b is ObservedBookmark => b.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** RFC-4122-shaped v4 UUID derived deterministically from a seed string. */
const deterministicUuid = (seed: string) =>
  Effect.sync(() => {
    const hex = crypto.createHash("sha256").update(seed).digest("hex");
    const bytes = hex.slice(0, 32).split("");
    bytes[12] = "4";
    bytes[16] = ((parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16);
    const s = bytes.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
  });

const toAttrs = (observed: ObservedBookmark, accountId: string) => ({
  bookmarkId: observed.id!,
  accountId,
  name: observed.name ?? "",
  domain: observed.domain ?? "",
  logoUrl: observed.logoUrl ?? undefined,
  appLauncherVisible: observed.appLauncherVisible ?? true,
});

type ObservedBookmark = {
  id?: string | null;
  name?: string | null;
  domain?: string | null;
  logoUrl?: string | null;
  appLauncherVisible?: boolean | null;
};
