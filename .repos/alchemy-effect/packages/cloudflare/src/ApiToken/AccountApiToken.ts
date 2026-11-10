import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import {
  buildConditionPayload,
  collectPolicies,
  conditionFingerprint,
  findTopLevelWorkerScriptKey,
  policyFingerprint,
  resolvePolicies,
  type ApiTokenBinding,
  type Props,
} from "./Common.ts";
import { uniqueTokens } from "./internal.ts";

export type AccountApiToken = Resource<
  "Cloudflare.ApiToken.AccountApiToken",
  Props,
  {
    tokenId: string;
    name: string;
    status: "active" | "disabled" | "expired";
    /**
     * The plaintext token value. Cloudflare returns this only once, on
     * creation, so we persist it here for downstream consumers (e.g. a
     * GitHub Actions secret).
     */
    value: Redacted.Redacted<string>;
    accountId: string;
  },
  ApiTokenBinding,
  Providers
>;

/**
 * A Cloudflare account-owned API token (`POST /accounts/{account_id}/tokens`).
 *
 * Account-owned tokens are managed at the account level and persist
 * independently of any single user. Use these for CI tokens, third-party
 * integrations, or anywhere the token should outlive an individual user's
 * session.
 *
 * Creating account-owned tokens requires the caller to have the
 * `API Tokens > Write` account permission.
 * ### Creating a Token
 * **Example:** A token for managing Workers and KV from CI
 * ```typescript
 * // the account ID resolves from the profile you're deploying with
 * const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
 *
 * const token = yield* Cloudflare.ApiToken.AccountApiToken("ci-token", {
 *   name: "my-ci-token",
 *   accountId,
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: [
 *         "Workers Scripts Write",
 *         "Workers KV Storage Write",
 *       ],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 *
 * yield* GitHub.Secret("cf-api-token", {
 *   owner: "me",
 *   repository: "my-repo",
 *   name: "CLOUDFLARE_API_TOKEN",
 *   value: token.value,
 * });
 * ```
 *
 * ### Scoping a Token to One Worker
 * **Example:** A deploy token that can only edit one Worker
 * The `Individual Workers` roles (`Admin`, `Editor`, `Content Read-Only`,
 * `Metadata Read-Only`) apply to a single Worker. Key the Worker by its
 * `workerId`, nested under the account. Only account-owned tokens accept
 * these roles.
 * ```typescript
 * const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
 * const api = yield* Cloudflare.Worker("Api", { main: "./src/api.ts" });
 *
 * const token = yield* Cloudflare.ApiToken.AccountApiToken("api-deploy-token", {
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: ["Individual Workers Editor"],
 *       resources: api.workerId.pipe(
 *         Output.map((workerId) => ({
 *           [`com.cloudflare.api.account.${accountId}`]: {
 *             [`com.cloudflare.edge.worker.script.${workerId}`]: "*",
 *           },
 *         })),
 *       ),
 *     },
 *   ],
 * });
 * ```
 *
 * ### Attaching Policies via Bindings
 * **Example:** Let a downstream capability contribute its own policies
 * A token can be created with no `policies` of its own; the policies are
 * supplied through its binding contract (see {@link ApiTokenBinding}). This is
 * how capabilities like {@link CreateTunnel} provision a least-privilege token.
 * ```typescript
 * const token = yield* Cloudflare.ApiToken.AccountApiToken("scoped-token");
 *
 * yield* token.bind("MyCapability", {
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: ["Cloudflare Tunnel Write"],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Exposing a Token to a Worker
 * **Example:** Read the token value at runtime
 * Bind the token's outputs in the Worker's Init phase to get runtime
 * accessors. Binding `token.value` injects it as a `secret_text` Worker
 * binding; the returned accessor reads it back (as `Redacted`) at runtime.
 * ```typescript
 * // init
 * const value = yield* token.value; // Accessor<Redacted<string>>
 * const accountId = yield* token.accountId; // Accessor<string>
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const apiToken = yield* value; // Redacted<string>
 *     // ... call the Cloudflare API with `apiToken`
 *     return HttpServerResponse.text("ok");
 *   }),
 * };
 * ```
 *
 * @resource
 * @product API Tokens
 * @category Account & Identity
 */
export const AccountApiToken = Resource<AccountApiToken>("Cloudflare.ApiToken.AccountApiToken", {
  aliases: ["Cloudflare.AccountApiToken"],
});

type AccountApiTokenAttributes = AccountApiToken["Attributes"];

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

const buildAttributes = (
  tokenData: {
    id?: string | null;
    name?: string | null;
    // Distilled widened generated string enums to open unions (`string & {}`).
    status?: string | null;
  },
  value: Redacted.Redacted<string>,
  accountId: string,
): AccountApiTokenAttributes => ({
  tokenId: tokenData.id ?? "",
  name: tokenData.name ?? "",
  status: (tokenData.status ?? "active") as "active" | "disabled" | "expired",
  value,
  accountId,
});

export const AccountApiTokenProvider = () =>
  Provider.succeed(AccountApiToken, {
    stables: ["tokenId", "accountId"],
    diff: Effect.fn(function* ({ id, olds, news = {}, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId: defaultAccountId } = yield* yield* CloudflareEnvironment;

      const newAccountId = news.accountId ?? defaultAccountId;
      const oldAccountId = output?.accountId ?? olds?.accountId ?? defaultAccountId;
      if (oldAccountId !== newAccountId) {
        return { action: "replace" } as const;
      }
      const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
      const newName = yield* resolveName(id, news.name);
      const oldPolicyFp = policyFingerprint(resolvePolicies(olds?.policies ?? []));
      const newPolicyFp = policyFingerprint(resolvePolicies(news.policies ?? []));
      const oldCondFp = conditionFingerprint(olds?.condition);
      const newCondFp = conditionFingerprint(news.condition);
      if (
        oldName !== newName ||
        oldPolicyFp !== newPolicyFp ||
        oldCondFp !== newCondFp ||
        (olds?.expiresOn ?? undefined) !== (news.expiresOn ?? undefined) ||
        (olds?.notBefore ?? undefined) !== (news.notBefore ?? undefined)
      ) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output, bindings }) {
      const { accountId: defaultAccountId } = yield* yield* CloudflareEnvironment;
      const accountId = news.accountId ?? defaultAccountId;
      const name = yield* resolveName(id, news.name);
      const collected = collectPolicies(news.policies, bindings);
      if (collected.length === 0) {
        return yield* Effect.die(
          `Cloudflare requires at least one policy on token "${name}". ` +
            "Pass `policies` or attach them via a binding.",
        );
      }
      const policies = resolvePolicies(collected);
      const workerScriptKey = findTopLevelWorkerScriptKey(policies);
      if (workerScriptKey) {
        return yield* Effect.die(
          `Token "${name}" lists "${workerScriptKey}" as a top-level resource. ` +
            "Cloudflare only accepts Worker resources nested under the account: " +
            `{ "com.cloudflare.api.account.${accountId}": { "${workerScriptKey}": "*" } }.`,
        );
      }

      // Observe — fetch current state if we already know the token id.
      // Cloudflare reports a deleted token as `InvalidRoute` or
      // `TokenNotFound`; both mean "create from scratch".
      const observed = output?.tokenId
        ? yield* accounts
            .getToken({
              accountId: output.accountId,
              tokenId: output.tokenId,
            })
            .pipe(
              Effect.map((token) => token),
              Effect.catchTags({
                InvalidRoute: () => Effect.undefined,
                TokenNotFound: () => Effect.undefined,
              }),
            )
        : undefined;

      // Ensure — create if missing. Cloudflare returns the plaintext
      // token value exactly once on create, so we must persist it for
      // downstream consumers. There is no idempotency token here; if
      // a stale write produced an orphan we accept the duplicate over
      // the alternative of losing the secret value.
      if (observed === undefined) {
        const result = yield* accounts.createToken({
          accountId,
          name,
          policies,
          condition: buildConditionPayload(news.condition),
          expiresOn: news.expiresOn,
          notBefore: news.notBefore,
        });
        if (!result.value) {
          return yield* Effect.die(`Cloudflare did not return a value for token "${name}".`);
        }
        return buildAttributes(result, Redacted.make(result.value), accountId);
      }

      // Sync — the update API replaces all mutable fields (name,
      // policies, condition, validity window). Cloudflare does not
      // return the plaintext value on update, so we preserve the one
      // captured at creation.
      const result = yield* accounts.updateToken({
        accountId,
        tokenId: output!.tokenId,
        name,
        policies,
        condition: buildConditionPayload(news.condition),
        expiresOn: news.expiresOn,
        notBefore: news.notBefore,
      });
      return buildAttributes(result, output!.value, accountId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* accounts
        .deleteToken({
          accountId: output.accountId,
          tokenId: output.tokenId,
        })
        .pipe(
          // Already gone — Cloudflare may report this as either an
          // `InvalidRoute` (token-id no longer routable) or a generic
          // `TokenNotFound`. Either is fine; we just want the resource gone.
          Effect.catchTags({
            InvalidRoute: () => Effect.void,
            TokenNotFound: () => Effect.void,
          }),
          // Cloudflare-managed tokens (e.g. "Cloudflare Resource Tagging
          // System") can never be deleted (code 1001). We don't own them, so
          // treat the refusal as a no-op rather than a failure.
          Effect.catchTag("TokenManagedByCloudflare", () => Effect.void),
        );
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The plaintext token value is only returned by Cloudflare once, at
      // creation time. The list/get APIs never expose it, so we hydrate an
      // empty redacted placeholder — matching what `read` returns when it
      // re-observes a token whose value we no longer hold.
      //
      // `GET /accounts/{id}/tokens` is offset-paginated over a name-sorted
      // list, so any token created or deleted between page fetches (e.g. a
      // concurrent deploy) shifts the window: tokens get listed twice or
      // skipped. Request the API's maximum page size (1000) so a typical
      // account is enumerated in one snapshot, and de-duplicate by id in
      // case it still spans pages.
      return yield* accounts.listTokens.pages({ accountId, perPage: 1000 }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          uniqueTokens(Array.from(chunk).flatMap((page) => page.result ?? [])).map((token) =>
            buildAttributes(token, Redacted.make(""), accountId),
          ),
        ),
      );
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output?.tokenId) return undefined;
      return yield* accounts
        .getToken({
          accountId: output.accountId,
          tokenId: output.tokenId,
        })
        .pipe(
          Effect.map((token) => buildAttributes(token, output.value, output.accountId)),
          Effect.catchTags({
            InvalidRoute: () => Effect.undefined,
            TokenNotFound: () => Effect.undefined,
          }),
        );
    }),
  });
