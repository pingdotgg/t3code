import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { testName } from "../../names.ts";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

describe(
  "AccountApiToken",
  { tags: ["provider:cloudflare", "provider:cloudflare:apitoken", "live"] },
  () => {
    test.provider(
      "create and delete account token with default props",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const token = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.ApiToken.AccountApiToken("DefaultToken", {
                policies: [
                  {
                    effect: "allow",
                    permissionGroups: ["Workers Scripts Read"],
                    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                  },
                ],
              });
            }),
          );

          expect(token.tokenId).toBeDefined();
          expect(token.name).toBeDefined();
          expect(token.status).toEqual("active");
          expect(Redacted.value(token.value)).toMatch(/.+/);

          const actualToken = yield* accounts.getToken({ accountId, tokenId: token.tokenId });
          expect(actualToken.id).toEqual(token.tokenId);
          expect(actualToken.name).toEqual(token.name);

          yield* stack.destroy();

          yield* waitForTokenToBeDeleted(token.tokenId, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:account"] },
    );

    test.provider(
      "create, update, delete account token",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const token = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.ApiToken.AccountApiToken("UpdateToken", {
                name: testName("alchemy-test-acct-update-initial"),
                policies: [
                  {
                    effect: "allow",
                    permissionGroups: ["Workers Scripts Read"],
                    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                  },
                ],
              });
            }),
          );

          expect(token.name).toEqual(testName("alchemy-test-acct-update-initial"));
          const initialValue = Redacted.value(token.value);

          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.ApiToken.AccountApiToken("UpdateToken", {
                name: testName("alchemy-test-acct-update-renamed"),
                policies: [
                  {
                    effect: "allow",
                    permissionGroups: ["Workers Scripts Read", "Workers KV Storage Read"],
                    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                  },
                ],
              });
            }),
          );

          expect(updated.tokenId).toEqual(token.tokenId);
          expect(updated.name).toEqual(testName("alchemy-test-acct-update-renamed"));
          expect(Redacted.value(updated.value)).toEqual(initialValue);

          const actual = yield* accounts.getToken({ accountId, tokenId: updated.tokenId });
          expect(actual.name).toEqual(testName("alchemy-test-acct-update-renamed"));
          expect(actual.policies?.[0]?.permissionGroups.length).toEqual(2);

          yield* stack.destroy();

          yield* waitForTokenToBeDeleted(token.tokenId, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:account"] },
    );

    test.provider("noop when account token props unchanged", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const props = {
          name: "alchemy-test-acct-noop",
          policies: [
            {
              effect: "allow" as const,
              permissionGroups: ["Workers Scripts Read" as const],
              resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            },
          ],
        };

        const first = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.ApiToken.AccountApiToken("NoopToken", props);
          }),
        );

        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.ApiToken.AccountApiToken("NoopToken", props);
          }),
        );

        expect(second.tokenId).toEqual(first.tokenId);
        expect(Redacted.value(second.value)).toEqual(Redacted.value(first.value));

        yield* stack.destroy();
      }).pipe(logLevel),
    );

    test.provider(
      "scopes an account token to one Worker",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const { token, allowed, denied } = yield* stack.deploy(
            Effect.gen(function* () {
              const allowed = yield* Cloudflare.Worker("ScopedWorker", {
                script: `export default { fetch: () => new Response("allowed") };`,
              });
              const denied = yield* Cloudflare.Worker("OtherWorker", {
                script: `export default { fetch: () => new Response("denied") };`,
              });
              const token = yield* Cloudflare.ApiToken.AccountApiToken("WorkerScopedToken", {
                policies: [
                  {
                    effect: "allow",
                    permissionGroups: ["Individual Workers Editor"],
                    resources: allowed.workerId.pipe(
                      Output.map((workerId) => ({
                        [`com.cloudflare.api.account.${accountId}`]: {
                          [`com.cloudflare.edge.worker.script.${workerId}`]: "*",
                        },
                      })),
                    ),
                  },
                ],
              });
              return { token, allowed, denied };
            }),
          );

          const actual = yield* accounts.getToken({ accountId, tokenId: token.tokenId });
          expect(actual.policies?.[0]?.resources).toEqual({
            [`com.cloudflare.api.account.${accountId}`]: {
              [`com.cloudflare.edge.worker.script.${allowed.workerId}`]: "*",
            },
          });

          // Call the Workers API as the scoped token: the Worker it is scoped
          // to is readable, the other one is not.
          const asToken = Effect.provide(Credentials.fromApiToken({ apiToken: token.value }));
          const settings = yield* workers
            .getScriptSetting({ accountId, scriptName: allowed.workerName })
            .pipe(
              asToken,
              // a freshly minted token takes a few seconds to propagate
              Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
            );
          expect(settings).toBeDefined();
          const error = yield* workers
            .getScriptSetting({ accountId, scriptName: denied.workerName })
            .pipe(asToken, Effect.flip);
          expect(error._tag).toEqual("Forbidden");

          yield* stack.destroy();

          yield* waitForTokenToBeDeleted(token.tokenId, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:account"] },
    );

    const waitForTokenToBeDeleted = Effect.fn(function* (tokenId: string, accountId: string) {
      yield* accounts.getToken({ accountId, tokenId }).pipe(
        Effect.flatMap(() => Effect.fail(new TokenStillExists())),
        Effect.retry({
          while: (e): e is TokenStillExists => e instanceof TokenStillExists,
          schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(8)]),
        }),
        Effect.catchTag("TokenStillExists", () =>
          Effect.die(`Cloudflare API token ${tokenId} was not deleted after retries`),
        ),
        Effect.catchTag("TokenNotFound", () => Effect.void),
        Effect.catchTag("InvalidRoute", () => Effect.void),
      );
    });
  },
);
class TokenStillExists extends Data.TaggedError("TokenStillExists") {}

describe(
  "AccountApiToken list",
  { tags: ["provider:cloudflare", "provider:cloudflare:apitoken", "live"] },
  () => {
    test.provider("list enumerates the deployed account token", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const token = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.ApiToken.AccountApiToken("ListToken", {
              policies: [
                {
                  effect: "allow",
                  permissionGroups: ["Workers Scripts Read"],
                  resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                },
              ],
            });
          }),
        );

        const provider = yield* Provider.findProvider(Cloudflare.ApiToken.AccountApiToken);
        const all = yield* provider.list();

        expect(all.some((t) => t.tokenId === token.tokenId)).toBe(true);
        const found = all.find((t) => t.tokenId === token.tokenId)!;
        expect(found.name).toEqual(token.name);
        expect(found.accountId).toEqual(accountId);

        yield* stack.destroy();
      }).pipe(logLevel),
    );
  },
);
