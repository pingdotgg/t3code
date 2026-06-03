import * as user from "@distilled.cloud/cloudflare/user";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  buildConditionPayload,
  collectPolicies,
  conditionFingerprint,
  policyFingerprint,
  resolvePolicies,
  type ApiTokenBinding,
  type ApiTokenProps,
} from "./Common.ts";

export type UserApiToken = Resource<
  "Cloudflare.UserApiToken",
  ApiTokenProps,
  {
    tokenId: string;
    name: string;
    status: "active" | "disabled" | "expired";
    /**
     * The plaintext token value. Cloudflare returns this only once, on
     * creation, so we persist it here for downstream consumers.
     */
    value: Redacted.Redacted<string>;
  },
  ApiTokenBinding,
  Providers
>;

/**
 * A Cloudflare user-owned API token (`POST /user/tokens`).
 *
 * User-owned tokens are tied to the authenticated user's identity. They can
 * be created by any authenticated user (including OAuth-derived sessions
 * from `alchemy login`) without needing the account-level
 * `API Tokens > Write` permission, but they are also revoked if the user
 * leaves the account.
 *
 * For CI tokens, prefer {@link AccountApiToken} so the token survives
 * personnel changes.
 *
 * Policy `resources` are passed through verbatim — no `accountId` rewriting
 * is performed because user tokens aren't bound to a single account.
 *
 * @section Creating a Token
 * @example A token bound to the authenticated user
 * ```typescript
 * const token = yield* Cloudflare.UserApiToken("personal-token", {
 *   name: "my-personal-token",
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: ["Workers Scripts Read"],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 * ```
 *
 * @section Attaching Policies via Bindings
 * @example Let a downstream capability contribute its own policies
 * A token can be created with no `policies` of its own; the policies are
 * supplied through its binding contract (see {@link ApiTokenBinding}).
 * ```typescript
 * const token = yield* Cloudflare.UserApiToken("scoped-token");
 *
 * yield* token.bind("MyCapability", {
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: ["Workers Scripts Read"],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 * ```
 *
 * @section Exposing a Token to a Worker
 * @example Read the token value at runtime
 * Bind the token's value output in the Worker's Init phase to get a runtime
 * accessor. Binding it injects a `secret_text` Worker binding; the returned
 * accessor reads it back (as `Redacted`) at runtime.
 * ```typescript
 * // init
 * const value = yield* token.value; // Accessor<Redacted<string>>
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const apiToken = yield* value; // Redacted<string>
 *     // ... call the Cloudflare API with `apiToken`
 *     return HttpServerResponse.text("ok");
 *   }),
 * };
 * ```
 */
export const UserApiToken = Resource<UserApiToken>("Cloudflare.UserApiToken");

type UserApiTokenAttributes = UserApiToken["Attributes"];

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

export const UserApiTokenProvider = () =>
  Provider.effect(
    UserApiToken,
    Effect.gen(function* () {
      const createToken = yield* user.createToken;
      const updateToken = yield* user.updateToken;
      const deleteToken = yield* user.deleteToken;
      const getToken = yield* user.getToken;

      const buildAttributes = (
        tokenData: {
          id?: string | null;
          name?: string | null;
          // Distilled widened generated string enums to open unions (`string & {}`).
          status?: string | null;
        },
        value: Redacted.Redacted<string>,
      ): UserApiTokenAttributes => ({
        tokenId: tokenData.id ?? "",
        name: tokenData.name ?? "",
        status: (tokenData.status ?? "active") as
          | "active"
          | "disabled"
          | "expired",
        value,
      });

      return {
        stables: ["tokenId"],
        diff: Effect.fn(function* ({ id, olds, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
          const newName = yield* resolveName(id, news.name);
          const oldPolicyFp = policyFingerprint(
            resolvePolicies(olds?.policies ?? []),
          );
          const newPolicyFp = policyFingerprint(
            resolvePolicies(news.policies ?? []),
          );
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
          const name = yield* resolveName(id, news.name);
          const collected = collectPolicies(news.policies, bindings);
          if (collected.length === 0) {
            return yield* Effect.die(
              `Cloudflare requires at least one policy on token "${name}". ` +
                "Pass `policies` or attach them via a binding.",
            );
          }
          const policies = resolvePolicies(collected);

          // Observe — fetch current state if we know the token id;
          // Cloudflare reports a deleted token as `TokenNotFound`, which
          // we treat as "create from scratch".
          const observed = output?.tokenId
            ? yield* getToken({ tokenId: output.tokenId }).pipe(
                Effect.map((token) => token),
                Effect.catchTag("TokenNotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : undefined;

          // Ensure — create if missing. Cloudflare returns the plaintext
          // token value exactly once on create, so we must persist it.
          // No idempotency token is available; we accept a duplicate over
          // losing the secret value.
          if (observed === undefined) {
            const result = yield* createToken({
              name,
              policies,
              condition: buildConditionPayload(news.condition),
              expiresOn: news.expiresOn,
              notBefore: news.notBefore,
            });
            if (!result.value) {
              return yield* Effect.die(
                `Cloudflare did not return a value for token "${name}".`,
              );
            }
            return buildAttributes(result, Redacted.make(result.value));
          }

          // Sync — the update API replaces all mutable fields. Cloudflare
          // does not return the plaintext value on update, so preserve
          // the one captured at creation.
          const result = yield* updateToken({
            tokenId: output!.tokenId,
            name,
            policies,
            condition: buildConditionPayload(news.condition),
            expiresOn: news.expiresOn,
            notBefore: news.notBefore,
          });
          return buildAttributes(result, output!.value);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteToken({ tokenId: output.tokenId }).pipe(
            Effect.catchTag("TokenNotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.tokenId) return undefined;
          return yield* getToken({ tokenId: output.tokenId }).pipe(
            Effect.map((token) => buildAttributes(token, output.value)),
            Effect.catchTag("TokenNotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
