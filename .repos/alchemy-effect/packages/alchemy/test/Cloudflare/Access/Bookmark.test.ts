import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The dedicated bookmarks API is deprecated: Cloudflare no longer allows
// creating NEW bookmark records through it. `POST
// /accounts/{id}/access/bookmarks/{uuid}` with a fresh UUID fails with HTTP
// 404 code 11021 "access.api.error.unknown_application" — surfaced as the
// typed `AccessBookmarkNotFound` error. The resource exists to manage
// pre-existing legacy records; the lifecycle test is gated behind an
// account that still has legacy bookmarks enabled, and the probe test
// always runs and pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_ACCESS_BOOKMARKS;

test.provider.skipIf(entitled)(
  "legacy bookmark creation surfaces the typed AccessBookmarkNotFound error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const error = yield* zeroTrust
        .createAccessBookmark({
          accountId,
          bookmarkId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0001",
          body: {
            name: "alchemy-access-bookmark-probe",
            domain: "wiki.alchemy-test-2.us",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AccessBookmarkNotFound");

      // The list endpoint still works — the legacy API is read-only for
      // accounts without pre-existing bookmark records.
      const bookmarks = yield* zeroTrust.listAccessBookmarks({ accountId });
      expect(Array.isArray(bookmarks.result)).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "create, update in place, and destroy bookmark",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bookmark = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Bookmark("Wiki", {
            domain: "wiki.alchemy-test-2.us",
          });
        }),
      );

      expect(bookmark.bookmarkId).toBeDefined();
      expect(bookmark.accountId).toEqual(accountId);
      expect(bookmark.domain).toEqual("wiki.alchemy-test-2.us");
      expect(bookmark.appLauncherVisible).toBe(true);

      const actual = yield* zeroTrust.getAccessBookmark({
        accountId,
        bookmarkId: bookmark.bookmarkId,
      });
      expect(actual.id).toEqual(bookmark.bookmarkId);

      // Update — domain and visibility converge in place (same id).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Bookmark("Wiki", {
            domain: "docs.alchemy-test-2.us",
            appLauncherVisible: false,
          });
        }),
      );
      expect(updated.bookmarkId).toEqual(bookmark.bookmarkId);
      expect(updated.domain).toEqual("docs.alchemy-test-2.us");
      expect(updated.appLauncherVisible).toBe(false);

      yield* stack.destroy();

      const afterDestroy = yield* zeroTrust
        .getAccessBookmark({
          accountId,
          bookmarkId: bookmark.bookmarkId,
        })
        .pipe(
          Effect.catchTag("AccessBookmarkNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterDestroy?.id ?? undefined).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// The legacy bookmarks list endpoint is read-only but available on every
// account (it returns `[]` when there are no records), so the ungated case
// always exercises `list()` and asserts it hydrates the `read` shape. The
// entitled path additionally deploys a bookmark and asserts its presence.
test.provider(
  "list enumerates access bookmarks at the account scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.Access.Bookmark);

      if (!entitled) {
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        for (const b of all) {
          expect(typeof b.bookmarkId).toBe("string");
          expect(typeof b.accountId).toBe("string");
        }
        return;
      }

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Bookmark("ListWiki", {
            domain: "wiki.alchemy-test-2.us",
          });
        }),
      );

      const all = yield* provider.list();
      expect(all.some((b) => b.bookmarkId === deployed.bookmarkId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
