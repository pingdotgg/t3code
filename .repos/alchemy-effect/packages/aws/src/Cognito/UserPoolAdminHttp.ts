import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import type { UserPool } from "./UserPool.ts";
import {
  UserPoolAdmin,
  type ListGroupsRequest,
  type ListUsersRequest,
  type UserPoolAdminClient,
} from "./UserPoolAdmin.ts";

/** The injected identifier field, in the distilled wire type. */
type UserPoolIdField = Pick<cip.AdminGetUserRequest, "UserPoolId">;

/**
 * HTTP implementation of {@link UserPoolAdmin}: grants the admin
 * `cognito-idp:*` actions on the bound pool's ARN and calls the Cognito
 * HTTP API with the function's IAM credentials.
 */
export const UserPoolAdminHttp = Layer.effect(
  UserPoolAdmin,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const adminCreateUser = yield* AWSBindings.withCredentials(cip.adminCreateUser);
    const adminGetUser = yield* AWSBindings.withCredentials(cip.adminGetUser);
    const adminSetUserPassword = yield* AWSBindings.withCredentials(cip.adminSetUserPassword);
    const adminUpdateUserAttributes = yield* AWSBindings.withCredentials(
      cip.adminUpdateUserAttributes,
    );
    const adminDeleteUserAttributes = yield* AWSBindings.withCredentials(
      cip.adminDeleteUserAttributes,
    );
    const adminDeleteUser = yield* AWSBindings.withCredentials(cip.adminDeleteUser);
    const adminConfirmSignUp = yield* AWSBindings.withCredentials(cip.adminConfirmSignUp);
    const adminDisableUser = yield* AWSBindings.withCredentials(cip.adminDisableUser);
    const adminEnableUser = yield* AWSBindings.withCredentials(cip.adminEnableUser);
    const adminResetUserPassword = yield* AWSBindings.withCredentials(cip.adminResetUserPassword);
    const adminInitiateAuth = yield* AWSBindings.withCredentials(cip.adminInitiateAuth);
    const adminRespondToAuthChallenge = yield* AWSBindings.withCredentials(
      cip.adminRespondToAuthChallenge,
    );
    const adminUserGlobalSignOut = yield* AWSBindings.withCredentials(cip.adminUserGlobalSignOut);
    const adminAddUserToGroup = yield* AWSBindings.withCredentials(cip.adminAddUserToGroup);
    const adminRemoveUserFromGroup = yield* AWSBindings.withCredentials(
      cip.adminRemoveUserFromGroup,
    );
    const adminListGroupsForUser = yield* AWSBindings.withCredentials(cip.adminListGroupsForUser);
    const adminSetUserMFAPreference = yield* AWSBindings.withCredentials(
      cip.adminSetUserMFAPreference,
    );
    const adminLinkProviderForUser = yield* AWSBindings.withCredentials(
      cip.adminLinkProviderForUser,
    );
    const adminDisableProviderForUser = yield* AWSBindings.withCredentials(
      cip.adminDisableProviderForUser,
    );
    const adminGetDevice = yield* AWSBindings.withCredentials(cip.adminGetDevice);
    const adminListDevices = yield* AWSBindings.withCredentials(cip.adminListDevices);
    const adminForgetDevice = yield* AWSBindings.withCredentials(cip.adminForgetDevice);
    const adminUpdateDeviceStatus = yield* AWSBindings.withCredentials(cip.adminUpdateDeviceStatus);
    const adminListUserAuthEvents = yield* AWSBindings.withCredentials(cip.adminListUserAuthEvents);
    const adminUpdateAuthEventFeedback = yield* AWSBindings.withCredentials(
      cip.adminUpdateAuthEventFeedback,
    );
    const listUsers = yield* AWSBindings.withCredentials(cip.listUsers);
    const listUsersInGroup = yield* AWSBindings.withCredentials(cip.listUsersInGroup);
    const listGroups = yield* AWSBindings.withCredentials(cip.listGroups);

    return Effect.fn(function* <P extends UserPool>(pool: P) {
      const UserPoolId = yield* pool.userPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Cognito.UserPoolAdmin(${pool})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "cognito-idp:AdminAddUserToGroup",
                "cognito-idp:AdminConfirmSignUp",
                "cognito-idp:AdminCreateUser",
                "cognito-idp:AdminDeleteUser",
                "cognito-idp:AdminDeleteUserAttributes",
                "cognito-idp:AdminDisableProviderForUser",
                "cognito-idp:AdminDisableUser",
                "cognito-idp:AdminEnableUser",
                "cognito-idp:AdminForgetDevice",
                "cognito-idp:AdminGetDevice",
                "cognito-idp:AdminGetUser",
                "cognito-idp:AdminInitiateAuth",
                "cognito-idp:AdminLinkProviderForUser",
                "cognito-idp:AdminListDevices",
                "cognito-idp:AdminListGroupsForUser",
                "cognito-idp:AdminListUserAuthEvents",
                "cognito-idp:AdminRemoveUserFromGroup",
                "cognito-idp:AdminResetUserPassword",
                "cognito-idp:AdminRespondToAuthChallenge",
                "cognito-idp:AdminSetUserMFAPreference",
                "cognito-idp:AdminSetUserPassword",
                "cognito-idp:AdminUpdateAuthEventFeedback",
                "cognito-idp:AdminUpdateDeviceStatus",
                "cognito-idp:AdminUpdateUserAttributes",
                "cognito-idp:AdminUserGlobalSignOut",
                "cognito-idp:ListGroups",
                "cognito-idp:ListUsers",
                "cognito-idp:ListUsersInGroup",
              ],
              Resource: [pool.userPoolArn],
            },
          ],
        });
      }
      const methods = cognitoMethods("AWS.Cognito.UserPoolAdmin", pool.LogicalId);
      const withPool = methods.injecting(
        Effect.map(UserPoolId, (id): UserPoolIdField => ({ UserPoolId: id })),
      );
      const adminClient: UserPoolAdminClient = {
        adminCreateUser: withPool("adminCreateUser", adminCreateUser),
        adminGetUser: withPool("adminGetUser", adminGetUser),
        adminSetUserPassword: withPool("adminSetUserPassword", adminSetUserPassword),
        adminUpdateUserAttributes: withPool("adminUpdateUserAttributes", adminUpdateUserAttributes),
        adminDeleteUserAttributes: withPool("adminDeleteUserAttributes", adminDeleteUserAttributes),
        adminDeleteUser: withPool("adminDeleteUser", adminDeleteUser),
        adminConfirmSignUp: withPool("adminConfirmSignUp", adminConfirmSignUp),
        adminDisableUser: withPool("adminDisableUser", adminDisableUser),
        adminEnableUser: withPool("adminEnableUser", adminEnableUser),
        adminResetUserPassword: withPool("adminResetUserPassword", adminResetUserPassword),
        adminInitiateAuth: withPool("adminInitiateAuth", adminInitiateAuth),
        adminRespondToAuthChallenge: withPool(
          "adminRespondToAuthChallenge",
          adminRespondToAuthChallenge,
        ),
        adminUserGlobalSignOut: withPool("adminUserGlobalSignOut", adminUserGlobalSignOut),
        adminAddUserToGroup: withPool("adminAddUserToGroup", adminAddUserToGroup),
        adminRemoveUserFromGroup: withPool("adminRemoveUserFromGroup", adminRemoveUserFromGroup),
        adminListGroupsForUser: withPool("adminListGroupsForUser", adminListGroupsForUser),
        adminSetUserMFAPreference: withPool("adminSetUserMFAPreference", adminSetUserMFAPreference),
        adminLinkProviderForUser: withPool("adminLinkProviderForUser", adminLinkProviderForUser),
        adminDisableProviderForUser: withPool(
          "adminDisableProviderForUser",
          adminDisableProviderForUser,
        ),
        adminGetDevice: withPool("adminGetDevice", adminGetDevice),
        adminListDevices: withPool("adminListDevices", adminListDevices),
        adminForgetDevice: withPool("adminForgetDevice", adminForgetDevice),
        adminUpdateDeviceStatus: withPool("adminUpdateDeviceStatus", adminUpdateDeviceStatus),
        adminListUserAuthEvents: withPool("adminListUserAuthEvents", adminListUserAuthEvents),
        adminUpdateAuthEventFeedback: withPool(
          "adminUpdateAuthEventFeedback",
          adminUpdateAuthEventFeedback,
        ),
        listUsersInGroup: withPool("listUsersInGroup", listUsersInGroup),
        // optional-request list operations stay bespoke (the helper's
        // wrapped methods take a required request object)
        listUsers: Effect.fn(`AWS.Cognito.UserPoolAdmin.listUsers(${pool.LogicalId})`)(function* (
          request: ListUsersRequest = {},
        ) {
          return yield* listUsers({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        listGroups: Effect.fn(`AWS.Cognito.UserPoolAdmin.listGroups(${pool.LogicalId})`)(function* (
          request: ListGroupsRequest = {},
        ) {
          return yield* listGroups({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
      };
      return adminClient;
    });
  }),
);
