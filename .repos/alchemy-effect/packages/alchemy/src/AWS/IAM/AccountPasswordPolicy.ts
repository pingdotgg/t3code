import * as iam from "@distilled.cloud/aws/iam";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { toWireDays } from "../../Util/Duration.ts";

export interface AccountPasswordPolicyProps extends Omit<
  iam.UpdateAccountPasswordPolicyRequest,
  "MaxPasswordAge"
> {
  /**
   * Maximum password validity duration, e.g. `"90 days"` or
   * `Duration.days(90)`. Sent to IAM as whole days (a bare number is
   * milliseconds).
   */
  MaxPasswordAge?: Duration.Input;
}

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
 * @resource
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
    // Account-level singleton: IAM exposes no enumeration API, only
    // `getAccountPasswordPolicy`. Return the single policy as a one-element
    // array, or `[]` when none is set (typed `NoSuchEntityException`).
    list: () =>
      iam.getAccountPasswordPolicy({}).pipe(
        Effect.map((response) => [response.PasswordPolicy]),
        Effect.catchTag("NoSuchEntityException", () => Effect.succeed([])),
      ),
    reconcile: Effect.fn(function* ({ news, session }) {
      // The account password policy is a singleton driven entirely by
      // `updateAccountPasswordPolicy`, which is itself a full upsert.
      // Observation is implicit in the API — there is nothing meaningful
      // to diff because the request payload *is* the desired state.
      const request = {
        ...news,
        MaxPasswordAge: toWireDays(news.MaxPasswordAge),
      };
      yield* iam.updateAccountPasswordPolicy(request);
      yield* session.note("account-password-policy");
      return request;
    }),
    delete: Effect.fn(function* () {
      yield* iam
        .deleteAccountPasswordPolicy({})
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
