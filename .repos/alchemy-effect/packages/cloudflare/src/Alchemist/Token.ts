import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { apiKeyCredentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Alchemist from "alchemy/Alchemist";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  selectableScopes,
  tokenPolicies,
  type PermissionGroup,
  type TokenPolicy,
} from "../Auth/TokenPolicy.ts";
import * as CloudflareCredentials from "../Credentials.ts";

export interface GlobalCredentials {
  readonly email: string;
  readonly apiKey: Redacted.Redacted<string>;
}

export interface Account {
  readonly id: string;
  readonly name: string;
}
export type { PermissionGroup, TokenPolicy } from "../Auth/TokenPolicy.ts";

export interface TokenCatalog {
  readonly accounts: ReadonlyArray<Account>;
  readonly permissionGroups: ReadonlyArray<PermissionGroup>;
}

export interface PlanInput {
  readonly credentials: GlobalCredentials;
  readonly name: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly permissionGroupIds: ReadonlyArray<string> | "all";
}

export interface TokenPlan {
  readonly name: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly permissionGroupIds: ReadonlyArray<string>;
  readonly permissionCount: number;
  readonly grantsFullAccess: boolean;
  readonly policies: ReadonlyArray<TokenPolicy>;
}

export interface CreateInput {
  readonly credentials: GlobalCredentials;
  readonly plan: TokenPlan;
}

export interface CreatedToken {
  readonly id: string;
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
  readonly grantedPermissionGroups: number;
  /** Echoed back by Cloudflare; may contain effects we never request. */
  readonly policies: ReadonlyArray<unknown>;
  readonly verificationStatus?: string;
  readonly diagnostics: ReadonlyArray<Alchemist.Diagnostic>;
}

/** Cloudflare accepted the create call but returned no usable token. */
export class CloudflareTokenError extends Data.TaggedError("CloudflareTokenError")<{
  readonly message: string;
}> {}

/** Authenticate the surrounding effect with the user's Global API Key. */
const withGlobalKey = (credentials: GlobalCredentials) =>
  Effect.provideService(
    CloudflareCredentials.Credentials,
    Effect.succeed(
      apiKeyCredentials({
        apiKey: credentials.apiKey,
        email: credentials.email,
      }),
    ),
  );

/** The accounts and permission groups a token can be scoped to. */
export const catalog = Effect.fn("Alchemist.cloudflare.token.catalog")(
  // The credentials only authenticate the call, via the transformer below.
  function* (_credentials: GlobalCredentials) {
    const listPermissionGroups = yield* user.listTokenPermissionGroups;
    const { accountList, permissionGroupResponse } = yield* Effect.all(
      {
        // GET /accounts pages at 20 by default; walk every page.
        accountList: accounts.listAccounts.items({ perPage: 50 }).pipe(Stream.runCollect),
        permissionGroupResponse: listPermissionGroups({}),
      },
      { concurrency: "unbounded" },
    );
    return {
      accounts: Array.from(accountList).map(({ id, name }) => ({
        id,
        name,
      })),
      permissionGroups: permissionGroupResponse.result.flatMap((group) =>
        group.id && group.name && group.scopes?.length
          ? [
              {
                id: group.id,
                name: group.name,
                category: group.category ?? undefined,
                scopes: group.scopes,
                selectable: selectableScopes.has(group.scopes[0]!),
              },
            ]
          : [],
      ),
    } satisfies TokenCatalog;
  },
  (effect, credentials) => withGlobalKey(credentials)(effect),
);

/** Resolve the selected permission groups into concrete token policies. */
export const plan = Effect.fn("Alchemist.cloudflare.token.plan")(function* (input: PlanInput) {
  const tokenCatalog = yield* catalog(input.credentials);
  const selected =
    input.permissionGroupIds === "all"
      ? tokenCatalog.permissionGroups
      : yield* Effect.forEach(input.permissionGroupIds, (id) => {
          const group = tokenCatalog.permissionGroups.find((candidate) => candidate.id === id);
          if (group === undefined) {
            return Effect.fail(
              new Alchemist.AlchemistInvalidInput({
                field: "permissionGroupIds",
                message: `Unknown Cloudflare permission group '${id}'.`,
              }),
            );
          }
          return Effect.succeed(group);
        });
  const currentUser = yield* user.getUser({}).pipe(withGlobalKey(input.credentials));
  const resolved = tokenPolicies(input.accountIds, currentUser.id, selected);
  if (resolved.length === 0) {
    return yield* new Alchemist.AlchemistInvalidInput({
      field: "permissionGroupIds",
      message: "No selected permission groups can be expressed as token policies.",
    });
  }
  return {
    name: input.name,
    accountIds: input.accountIds,
    permissionGroupIds: selected.map(({ id }) => id),
    permissionCount: selected.length,
    grantsFullAccess: input.permissionGroupIds === "all",
    policies: resolved,
  } satisfies TokenPlan;
});

/** Mint the planned token with the user's Global API Key. */
export const create = Effect.fn("Alchemist.cloudflare.token.create")(
  function* (input: CreateInput) {
    const result = yield* user.createToken({
      name: input.plan.name,
      policies: input.plan.policies as TokenPolicy[],
    });
    if (!result.value) {
      return yield* new CloudflareTokenError({
        message: "Cloudflare did not return a token value.",
      });
    }
    const granted = (result.policies ?? []).reduce(
      (count, policy) => count + (policy.permissionGroups?.length ?? 0),
      0,
    );
    const verificationStatus = yield* user.verifyToken({}).pipe(
      Effect.provideService(
        CloudflareCredentials.Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make(result.value) })),
      ),
      Effect.map(({ status }) => status),
      Effect.orElseSucceed(() => undefined),
    );
    return {
      id: result.id ?? "unknown",
      name: result.name ?? input.plan.name,
      value: Redacted.make(result.value),
      grantedPermissionGroups: granted,
      policies: result.policies ?? input.plan.policies,
      verificationStatus,
      diagnostics:
        granted === 0
          ? [
              {
                severity: "warning" as const,
                code: "cloudflare.token.zero-permissions",
                message: "Cloudflare created the token with zero permissions.",
              },
            ]
          : [],
    } satisfies CreatedToken;
  },
  (effect, input) => withGlobalKey(input.credentials)(effect),
);
