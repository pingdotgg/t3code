import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface AccountPasswordPolicyProps
  extends iam.UpdateAccountPasswordPolicyRequest {}

export interface AccountPasswordPolicy extends Resource<
  "AWS.IAM.AccountPasswordPolicy",
  AccountPasswordPolicyProps,
  iam.PasswordPolicy,
  never,
  Providers
> {}

/**
 * The singleton IAM account password policy.
 *
 * `AccountPasswordPolicy` manages the account-wide password requirements that
 * apply to IAM users with console passwords.
 *
 * @section Managing Password Rules
 * @example Require Strong Passwords
 * ```typescript
 * const policy = yield* AccountPasswordPolicy("PasswordPolicy", {
 *   MinimumPasswordLength: 16,
 *   RequireSymbols: true,
 *   RequireNumbers: true,
 *   RequireUppercaseCharacters: true,
 *   RequireLowercaseCharacters: true,
 *   AllowUsersToChangePassword: true,
 * });
 * ```
 */
export const AccountPasswordPolicy = Resource<AccountPasswordPolicy>(
  "AWS.IAM.AccountPasswordPolicy",
);

export const AccountPasswordPolicyProvider = () =>
  Provider.succeed(AccountPasswordPolicy, {
    read: Effect.fn(function* () {
      const response = yield* iam
        .getAccountPasswordPolicy({})
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      return response?.PasswordPolicy;
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      // The account password policy is a singleton driven entirely by
      // `updateAccountPasswordPolicy`, which is itself a full upsert.
      // Observation is implicit in the API — there is nothing meaningful
      // to diff because the request payload *is* the desired state.
      yield* iam.updateAccountPasswordPolicy(news);
      yield* session.note("account-password-policy");
      return news;
    }),
    delete: Effect.fn(function* () {
      yield* iam
        .deleteAccountPasswordPolicy({})
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
