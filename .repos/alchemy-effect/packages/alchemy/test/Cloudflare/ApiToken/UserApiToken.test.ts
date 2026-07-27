import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as user from "@distilled.cloud/cloudflare/user";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
describe.skip("UserApiToken", () => {
  test.provider("create and delete user token with default props", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiToken.UserApiToken("DefaultUserToken", {
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      expect(token.tokenId).toBeDefined();
      expect(token.name).toBeDefined();
      expect(token.status).toEqual("active");
      expect(Redacted.value(token.value)).toMatch(/.+/);

      const actualToken = yield* user.getToken({ tokenId: token.tokenId });
      expect(actualToken.id).toEqual(token.tokenId);
      expect(actualToken.name).toEqual(token.name);

      yield* stack.destroy();

      yield* waitForTokenToBeDeleted(token.tokenId);
    }).pipe(logLevel),
  );

  test.provider("create, update, delete user token", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiToken.UserApiToken("UpdateUserToken", {
            name: "alchemy-test-user-update-initial",
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      expect(token.name).toEqual("alchemy-test-user-update-initial");
      const initialValue = Redacted.value(token.value);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiToken.UserApiToken("UpdateUserToken", {
            name: "alchemy-test-user-update-renamed",
            policies: [
              {
                effect: "allow",
                permissionGroups: [
                  "Workers Scripts Read",
                  "Workers KV Storage Read",
                ],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      expect(updated.tokenId).toEqual(token.tokenId);
      expect(updated.name).toEqual("alchemy-test-user-update-renamed");
      expect(Redacted.value(updated.value)).toEqual(initialValue);

      const actual = yield* user.getToken({ tokenId: updated.tokenId });
      expect(actual.name).toEqual("alchemy-test-user-update-renamed");
      expect(actual.policies?.[0]?.permissionGroups.length).toEqual(2);

      yield* stack.destroy();

      yield* waitForTokenToBeDeleted(token.tokenId);
    }).pipe(logLevel),
  );

  const waitForTokenToBeDeleted = Effect.fn(function* (tokenId: string) {
    yield* user.getToken({ tokenId }).pipe(
      Effect.flatMap(() => Effect.fail(new TokenStillExists())),
      Effect.retry({
        while: (e): e is TokenStillExists => e instanceof TokenStillExists,
        schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(8)]),
      }),
      Effect.catchTag("TokenStillExists", () =>
        Effect.die(
          `Cloudflare API token ${tokenId} was not deleted after retries`,
        ),
      ),
      Effect.catchTag("TokenNotFound", () => Effect.void),
      Effect.catchTag("InvalidRoute", () => Effect.void),
    );
  });
});

describe("UserApiToken list", () => {
  // Read-only: `GET /user/tokens` requires the authenticated *user's* identity.
  // The standing testing profile authenticates with a scoped API token that
  // lacks the `API Tokens > Read` user permission, so the live call rejects
  // with the typed error:
  //   Unauthorized: Unauthorized to access requested resource  (_tag: "Unauthorized")
  // The `list()` impl is correct (it propagates the typed error rather than
  // masking it as []), so we gate the live assertion behind an env var an
  // entitled (user-API-key) credential can set. The test only asserts the
  // provider exhaustively enumerates into the read-shaped Attributes.
  test.provider.skipIf(!process.env.CLOUDFLARE_TEST_USER_TOKENS)(
    "list enumerates user tokens",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(
          Cloudflare.ApiToken.UserApiToken,
        );
        const all = yield* provider.list();

        expect(Array.isArray(all)).toBe(true);
        for (const token of all) {
          expect(typeof token.tokenId).toBe("string");
          expect(typeof token.name).toBe("string");
          expect(["active", "disabled", "expired"]).toContain(token.status);
          // List never returns the plaintext value; read shape is preserved
          // with an empty Redacted secret.
          expect(typeof Redacted.value(token.value)).toBe("string");
        }
      }).pipe(logLevel),
  );
});

// Ungated probe: the standing scoped-token testing profile must surface the
// auth gap as the typed `Unauthorized` tag (not an UnknownCloudflareError),
// proving the error is in the typed union and the gating above is correct.
describe("UserApiToken list probe", () => {
  test.provider("list rejects with typed Unauthorized under scoped token", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.ApiToken.UserApiToken,
      );
      const result = yield* Effect.result(provider.list());
      if (Result.isSuccess(result)) {
        // An entitled credential can list — that's fine, nothing to assert.
        expect(Array.isArray(result.success)).toBe(true);
        return;
      }
      expect(result.failure._tag).toBe("Unauthorized");
    }).pipe(logLevel),
  );
});

class TokenStillExists extends Data.TaggedError("TokenStillExists") {}
