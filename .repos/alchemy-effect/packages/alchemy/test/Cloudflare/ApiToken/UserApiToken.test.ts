import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as user from "@distilled.cloud/cloudflare/user";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
describe.skip("UserApiToken", () => {
  test.provider("create and delete user token with default props", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("DefaultUserToken", {
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
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UpdateUserToken", {
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
          return yield* Cloudflare.UserApiToken("UpdateUserToken", {
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
        schedule: Schedule.exponential(200).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
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
class TokenStillExists extends Data.TaggedError("TokenStillExists") {}
