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

// Access custom pages are a plan-gated feature: on the standard testing
// account `POST /accounts/{id}/access/custom_pages` fails with HTTP 403 code
// 12133 "account does not have permission for custom pages" — surfaced as
// the typed `AccessCustomPagesNotEntitled` error. The full lifecycle is
// gated behind an entitled account supplied via env; the probe test always
// runs and pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_ACCESS_CUSTOM_PAGES;

const HTML_A = "<html><body><h1>Access denied</h1></body></html>";
const HTML_B = "<html><body><h1>Still denied</h1></body></html>";

test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed AccessCustomPagesNotEntitled error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const error = yield* zeroTrust
        .createAccessCustomPage({
          accountId,
          name: "alchemy-access-custom-page-probe",
          type: "forbidden",
          customHtml: HTML_A,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AccessCustomPagesNotEntitled");

      // Reads on the same account succeed, proving the gate is on
      // creation, not on the API token.
      const direct = yield* zeroTrust
        .getAccessCustomPage({
          accountId,
          customPageId: "00000000-0000-0000-0000-000000000000",
        })
        .pipe(
          Effect.catchTag("AccessCustomPageNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(direct).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "create, update html in place, replace on type change, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const page = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.CustomPage("BlockPage", {
            type: "forbidden",
            customHtml: HTML_A,
          });
        }),
      );

      expect(page.customPageId).toBeDefined();
      expect(page.accountId).toEqual(accountId);
      expect(page.type).toEqual("forbidden");

      const actual = yield* zeroTrust.getAccessCustomPage({
        accountId,
        customPageId: page.customPageId,
      });
      expect(actual.uid).toEqual(page.customPageId);
      expect(actual.customHtml).toEqual(HTML_A);

      // Update — html converges in place (same uid).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.CustomPage("BlockPage", {
            type: "forbidden",
            customHtml: HTML_B,
          });
        }),
      );
      expect(updated.customPageId).toEqual(page.customPageId);

      const afterUpdate = yield* zeroTrust.getAccessCustomPage({
        accountId,
        customPageId: page.customPageId,
      });
      expect(afterUpdate.customHtml).toEqual(HTML_B);

      // Replace — the type cannot change in place.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.CustomPage("BlockPage", {
            type: "identity_denied",
            customHtml: HTML_B,
          });
        }),
      );
      expect(replaced.customPageId).not.toEqual(page.customPageId);
      expect(replaced.type).toEqual("identity_denied");

      yield* stack.destroy();

      const afterDestroy = yield* zeroTrust
        .getAccessCustomPage({
          accountId,
          customPageId: replaced.customPageId,
        })
        .pipe(
          Effect.catchTag("AccessCustomPageNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterDestroy?.uid ?? undefined).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// The custom-pages list endpoint is available on every account (it returns
// `[]` when there are no records), so the ungated case always exercises
// `list()` and asserts it hydrates the `read` shape. The entitled path
// additionally deploys a page and asserts its presence.
test.provider(
  "list enumerates access custom pages at the account scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.CustomPage,
      );

      if (!entitled) {
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        for (const p of all) {
          expect(typeof p.customPageId).toBe("string");
          expect(typeof p.accountId).toBe("string");
          expect(typeof p.name).toBe("string");
        }
        return;
      }

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.CustomPage("ListPage", {
            type: "forbidden",
            customHtml: HTML_A,
          });
        }),
      );

      const all = yield* provider.list();
      expect(all.some((p) => p.customPageId === deployed.customPageId)).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
