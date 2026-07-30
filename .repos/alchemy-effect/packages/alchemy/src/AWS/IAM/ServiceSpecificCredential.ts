import * as iam from "@distilled.cloud/aws/iam";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { toWireDays } from "../../Util/Duration.ts";
import { toRedactedString } from "./common.ts";

export interface ServiceSpecificCredentialProps {
  /**
   * User that owns the service-specific credential.
   */
  userName: string;
  /**
   * AWS service name that will consume the credential.
   */
  serviceName: string;
  /**
   * Optional credential validity duration, e.g. `"30 days"` or
   * `Duration.days(30)`. Sent to IAM as whole days (a bare number is
   * milliseconds). Changing it replaces the credential.
   */
  credentialAge?: Duration.Input;
  /**
   * Desired credential status.
   * @default "Active"
   */
  status?: iam.StatusType;
}

export interface ServiceSpecificCredential extends Resource<
  "AWS.IAM.ServiceSpecificCredential",
  ServiceSpecificCredentialProps,
  {
    /** The IAM user the credential belongs to. */
    userName: string;
    /** The AWS service the credential is scoped to (e.g. `codecommit.amazonaws.com`). */
    serviceName: string;
    /** The unique ID of the credential. */
    serviceSpecificCredentialId: string;
    /** Whether the credential is `Active` or `Inactive`. */
    status: iam.StatusType;
    /** When the credential was created. */
    createDate: Date | undefined;
    /** When the credential expires, if an age was configured. */
    expirationDate: Date | undefined;
    /** The generated service-specific user name. */
    serviceUserName: string | undefined;
    /** The generated credential alias, if the service issues one. */
    serviceCredentialAlias: string | undefined;
    /** The generated password. AWS only returns it at creation; later reads preserve the originally stored redacted value. */
    servicePassword: Redacted.Redacted<string> | undefined;
    /** The generated secret. AWS only returns it at creation; later reads preserve the originally stored redacted value. */
    serviceCredentialSecret: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A service-specific IAM credential.
 *
 * `ServiceSpecificCredential` creates service-bound credentials such as
 * CodeCommit HTTPS passwords for an IAM user. AWS only returns the secret
 * fields during creation, so subsequent reads preserve the originally stored
 * redacted values.
 * @resource
 * @section Managing Service Credentials
 * @example Create a CodeCommit Credential
 * ```typescript
 * const user = yield* User("CodeCommitUser", {
 *   userName: "codecommit-user",
 * });
 *
 * const credential = yield* ServiceSpecificCredential("CodeCommitCredential", {
 *   userName: user.userName,
 *   serviceName: "codecommit.amazonaws.com",
 * });
 * ```
 */
export const ServiceSpecificCredential = Resource<ServiceSpecificCredential>(
  "AWS.IAM.ServiceSpecificCredential",
);

export const ServiceSpecificCredentialProvider = () =>
  Provider.succeed(ServiceSpecificCredential, {
    stables: ["serviceSpecificCredentialId"],
    list: Effect.fn(function* () {
      // Service-specific credentials are owned per IAM user and IAM is a
      // global service, so enumerate every user in the account
      // (`listUsers`) and fan out `listServiceSpecificCredentials` per user
      // (bounded concurrency). Omit `ServiceName` to capture credentials
      // across all services. The credential secret is only returned at
      // creation, so list cannot recover it — match `read` and leave the
      // redacted secret fields undefined.
      const users = yield* iam.listUsers.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.Users)),
      );
      const perUser = yield* Effect.forEach(
        users,
        (user) =>
          iam.listServiceSpecificCredentials({ UserName: user.UserName }).pipe(
            Effect.map((response) =>
              (response.ServiceSpecificCredentials ?? []).map((metadata) => ({
                userName: metadata.UserName,
                serviceName: metadata.ServiceName,
                serviceSpecificCredentialId:
                  metadata.ServiceSpecificCredentialId,
                status: metadata.Status,
                createDate: metadata.CreateDate,
                expirationDate: metadata.ExpirationDate,
                serviceUserName: metadata.ServiceUserName,
                serviceCredentialAlias: metadata.ServiceCredentialAlias,
                servicePassword: undefined,
                serviceCredentialSecret: undefined,
              })),
            ),
            // The user may be deleted between enumeration and per-user list.
            Effect.catchTag("NoSuchEntityException", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perUser.flat();
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (
        olds.userName !== news.userName ||
        olds.serviceName !== news.serviceName ||
        toWireDays(olds.credentialAge) !== toWireDays(news.credentialAge)
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const listed = yield* iam.listServiceSpecificCredentials({
        UserName: output.userName,
        ServiceName: output.serviceName,
      });
      const metadata = listed.ServiceSpecificCredentials?.find(
        (entry) =>
          entry.ServiceSpecificCredentialId ===
          output.serviceSpecificCredentialId,
      );
      if (!metadata?.ServiceSpecificCredentialId) {
        return undefined;
      }
      return {
        userName: metadata.UserName,
        serviceName: metadata.ServiceName,
        serviceSpecificCredentialId: metadata.ServiceSpecificCredentialId,
        status: metadata.Status,
        createDate: metadata.CreateDate,
        expirationDate: metadata.ExpirationDate,
        serviceUserName: metadata.ServiceUserName,
        serviceCredentialAlias: metadata.ServiceCredentialAlias,
        servicePassword: output.servicePassword,
        serviceCredentialSecret: output.serviceCredentialSecret,
      };
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      // Observe — credential ids are AWS-generated; we can only locate
      // the existing record via the prior output. The credential's
      // identity (userName, serviceName, age) is immutable (`diff`
      // triggers replacement on change), so a missing credential always
      // requires recreation.
      const observed = output
        ? yield* iam
            .listServiceSpecificCredentials({
              UserName: output.userName,
              ServiceName: output.serviceName,
            })
            .pipe(
              Effect.map((r) =>
                r.ServiceSpecificCredentials?.find(
                  (entry) =>
                    entry.ServiceSpecificCredentialId ===
                    output.serviceSpecificCredentialId,
                ),
              ),
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            )
        : undefined;

      // Ensure — create when missing. The secret fields are only
      // returned on first creation, so adoption preserves the prior
      // redacted values.
      let credentialId =
        observed?.ServiceSpecificCredentialId ??
        output?.serviceSpecificCredentialId;
      let userName = observed?.UserName ?? output?.userName ?? news.userName;
      let serviceName =
        observed?.ServiceName ?? output?.serviceName ?? news.serviceName;
      let createDate = observed?.CreateDate ?? output?.createDate;
      let expirationDate = observed?.ExpirationDate ?? output?.expirationDate;
      let serviceUserName =
        observed?.ServiceUserName ?? output?.serviceUserName;
      let serviceCredentialAlias =
        observed?.ServiceCredentialAlias ?? output?.serviceCredentialAlias;
      let servicePassword = output?.servicePassword;
      let serviceCredentialSecret = output?.serviceCredentialSecret;
      let observedStatus = observed?.Status ?? output?.status;

      if (!observed) {
        const created = yield* iam.createServiceSpecificCredential({
          UserName: news.userName,
          ServiceName: news.serviceName,
          CredentialAgeDays: toWireDays(news.credentialAge),
        });
        const credential = created.ServiceSpecificCredential;
        if (!credential?.ServiceSpecificCredentialId) {
          return yield* Effect.fail(
            new Error(
              `createServiceSpecificCredential returned no credential id`,
            ),
          );
        }
        credentialId = credential.ServiceSpecificCredentialId;
        userName = credential.UserName;
        serviceName = credential.ServiceName;
        createDate = credential.CreateDate;
        expirationDate = credential.ExpirationDate;
        serviceUserName = credential.ServiceUserName;
        serviceCredentialAlias = credential.ServiceCredentialAlias;
        servicePassword = toRedactedString(credential.ServicePassword);
        serviceCredentialSecret = toRedactedString(
          credential.ServiceCredentialSecret,
        );
        observedStatus = credential.Status;
      }

      if (!credentialId) {
        return yield* Effect.fail(
          new Error(
            `ServiceSpecificCredential for user '${news.userName}' has no id`,
          ),
        );
      }

      // Sync — apply the desired status when it differs from observed.
      const desiredStatus = news.status ?? observedStatus ?? "Active";
      if (desiredStatus !== observedStatus) {
        yield* iam.updateServiceSpecificCredential({
          UserName: userName,
          ServiceSpecificCredentialId: credentialId,
          Status: desiredStatus,
        });
      }

      yield* session.note(credentialId);
      return {
        userName,
        serviceName,
        serviceSpecificCredentialId: credentialId,
        status: desiredStatus,
        createDate,
        expirationDate,
        serviceUserName,
        serviceCredentialAlias,
        servicePassword,
        serviceCredentialSecret,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteServiceSpecificCredential({
          UserName: output.userName,
          ServiceSpecificCredentialId: output.serviceSpecificCredentialId,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
