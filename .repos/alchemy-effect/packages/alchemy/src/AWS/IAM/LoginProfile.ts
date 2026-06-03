import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { unwrapRedactedString } from "./common.ts";

export interface LoginProfileProps {
  /**
   * User that owns the console login profile.
   */
  userName: string;
  /**
   * Console password. AWS never returns this value after create/update.
   */
  password: Redacted.Redacted<string> | string;
  /**
   * Require a password reset on next sign in.
   */
  passwordResetRequired?: boolean;
}

export interface LoginProfile extends Resource<
  "AWS.IAM.LoginProfile",
  LoginProfileProps,
  {
    userName: string;
    createDate: Date | undefined;
    passwordResetRequired: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * An IAM console login profile for a user.
 *
 * `LoginProfile` manages AWS Management Console access for an IAM user. The
 * password is write-only, so AWS never returns it during later reads.
 *
 * @section Managing Console Access
 * @example Create a Console Login Profile
 * ```typescript
 * const user = yield* User("ConsoleUser", {
 *   userName: "console-user",
 * });
 *
 * const profile = yield* LoginProfile("ConsoleLogin", {
 *   userName: user.userName,
 *   password: Redacted.make("TempPassword123!"),
 *   passwordResetRequired: true,
 * });
 * ```
 */
export const LoginProfile = Resource<LoginProfile>("AWS.IAM.LoginProfile");

export const LoginProfileProvider = () =>
  Provider.succeed(LoginProfile, {
    stables: ["userName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.userName !== news.userName) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getLoginProfile({
          UserName: output.userName,
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response?.LoginProfile) {
        return undefined;
      }
      return {
        userName: response.LoginProfile.UserName,
        createDate: response.LoginProfile.CreateDate,
        passwordResetRequired: response.LoginProfile.PasswordResetRequired,
      };
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      // Observe — read the live login profile (or absence) for the user.
      const observed = yield* iam
        .getLoginProfile({ UserName: news.userName })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );

      // Ensure / Sync — the password is write-only, so we always send the
      // desired value. Use `createLoginProfile` when the profile is
      // missing and `updateLoginProfile` otherwise. A race that turns the
      // create into `EntityAlreadyExistsException` is recovered by
      // calling update.
      let response = observed;
      if (!observed?.LoginProfile) {
        response = yield* iam
          .createLoginProfile({
            UserName: news.userName,
            Password: unwrapRedactedString(news.password),
            PasswordResetRequired: news.passwordResetRequired,
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              Effect.gen(function* () {
                yield* iam.updateLoginProfile({
                  UserName: news.userName,
                  Password: unwrapRedactedString(news.password),
                  PasswordResetRequired: news.passwordResetRequired,
                });
                return yield* iam.getLoginProfile({
                  UserName: news.userName,
                });
              }),
            ),
          );
      } else {
        yield* iam.updateLoginProfile({
          UserName: news.userName,
          Password: unwrapRedactedString(news.password),
          PasswordResetRequired: news.passwordResetRequired,
        });
        response = yield* iam.getLoginProfile({ UserName: news.userName });
      }

      yield* session.note(news.userName);
      return {
        userName: response!.LoginProfile.UserName,
        createDate: response!.LoginProfile.CreateDate,
        passwordResetRequired: response!.LoginProfile.PasswordResetRequired,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteLoginProfile({
          UserName: output.userName,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
