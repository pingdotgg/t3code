import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
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
    const adminCreateUser = yield* cip.adminCreateUser;
    const adminGetUser = yield* cip.adminGetUser;
    const adminSetUserPassword = yield* cip.adminSetUserPassword;
    const adminUpdateUserAttributes = yield* cip.adminUpdateUserAttributes;
    const adminDeleteUserAttributes = yield* cip.adminDeleteUserAttributes;
    const adminDeleteUser = yield* cip.adminDeleteUser;
    const adminConfirmSignUp = yield* cip.adminConfirmSignUp;
    const adminDisableUser = yield* cip.adminDisableUser;
    const adminEnableUser = yield* cip.adminEnableUser;
    const adminResetUserPassword = yield* cip.adminResetUserPassword;
    const adminInitiateAuth = yield* cip.adminInitiateAuth;
    const adminRespondToAuthChallenge = yield* cip.adminRespondToAuthChallenge;
    const adminUserGlobalSignOut = yield* cip.adminUserGlobalSignOut;
    const adminAddUserToGroup = yield* cip.adminAddUserToGroup;
    const adminRemoveUserFromGroup = yield* cip.adminRemoveUserFromGroup;
    const adminListGroupsForUser = yield* cip.adminListGroupsForUser;
    const adminSetUserMFAPreference = yield* cip.adminSetUserMFAPreference;
    const adminLinkProviderForUser = yield* cip.adminLinkProviderForUser;
    const adminDisableProviderForUser = yield* cip.adminDisableProviderForUser;
    const adminGetDevice = yield* cip.adminGetDevice;
    const adminListDevices = yield* cip.adminListDevices;
    const adminForgetDevice = yield* cip.adminForgetDevice;
    const adminUpdateDeviceStatus = yield* cip.adminUpdateDeviceStatus;
    const adminListUserAuthEvents = yield* cip.adminListUserAuthEvents;
    const adminUpdateAuthEventFeedback =
      yield* cip.adminUpdateAuthEventFeedback;
    const listUsers = yield* cip.listUsers;
    const listUsersInGroup = yield* cip.listUsersInGroup;
    const listGroups = yield* cip.listGroups;

    return Effect.fn(function* <P extends UserPool>(pool: P) {
      const UserPoolId = yield* pool.userPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Cognito.UserPoolAdmin(${pool}))`({
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
      }
      const methods = cognitoMethods(
        "AWS.Cognito.UserPoolAdmin",
        pool.LogicalId,
      );
      const withPool = methods.injecting(
        Effect.map(UserPoolId, (id): UserPoolIdField => ({ UserPoolId: id })),
      );
      const adminClient: UserPoolAdminClient = {
        adminCreateUser: withPool("adminCreateUser", adminCreateUser),
        adminGetUser: withPool("adminGetUser", adminGetUser),
        adminSetUserPassword: withPool(
          "adminSetUserPassword",
          adminSetUserPassword,
        ),
        adminUpdateUserAttributes: withPool(
          "adminUpdateUserAttributes",
          adminUpdateUserAttributes,
        ),
        adminDeleteUserAttributes: withPool(
          "adminDeleteUserAttributes",
          adminDeleteUserAttributes,
        ),
        adminDeleteUser: withPool("adminDeleteUser", adminDeleteUser),
        adminConfirmSignUp: withPool("adminConfirmSignUp", adminConfirmSignUp),
        adminDisableUser: withPool("adminDisableUser", adminDisableUser),
        adminEnableUser: withPool("adminEnableUser", adminEnableUser),
        adminResetUserPassword: withPool(
          "adminResetUserPassword",
          adminResetUserPassword,
        ),
        adminInitiateAuth: withPool("adminInitiateAuth", adminInitiateAuth),
        adminRespondToAuthChallenge: withPool(
          "adminRespondToAuthChallenge",
          adminRespondToAuthChallenge,
        ),
        adminUserGlobalSignOut: withPool(
          "adminUserGlobalSignOut",
          adminUserGlobalSignOut,
        ),
        adminAddUserToGroup: withPool(
          "adminAddUserToGroup",
          adminAddUserToGroup,
        ),
        adminRemoveUserFromGroup: withPool(
          "adminRemoveUserFromGroup",
          adminRemoveUserFromGroup,
        ),
        adminListGroupsForUser: withPool(
          "adminListGroupsForUser",
          adminListGroupsForUser,
        ),
        adminSetUserMFAPreference: withPool(
          "adminSetUserMFAPreference",
          adminSetUserMFAPreference,
        ),
        adminLinkProviderForUser: withPool(
          "adminLinkProviderForUser",
          adminLinkProviderForUser,
        ),
        adminDisableProviderForUser: withPool(
          "adminDisableProviderForUser",
          adminDisableProviderForUser,
        ),
        adminGetDevice: withPool("adminGetDevice", adminGetDevice),
        adminListDevices: withPool("adminListDevices", adminListDevices),
        adminForgetDevice: withPool("adminForgetDevice", adminForgetDevice),
        adminUpdateDeviceStatus: withPool(
          "adminUpdateDeviceStatus",
          adminUpdateDeviceStatus,
        ),
        adminListUserAuthEvents: withPool(
          "adminListUserAuthEvents",
          adminListUserAuthEvents,
        ),
        adminUpdateAuthEventFeedback: withPool(
          "adminUpdateAuthEventFeedback",
          adminUpdateAuthEventFeedback,
        ),
        listUsersInGroup: withPool("listUsersInGroup", listUsersInGroup),
        // optional-request list operations stay bespoke (the helper's
        // wrapped methods take a required request object)
        listUsers: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.listUsers(${pool.LogicalId})`,
        )(function* (request: ListUsersRequest = {}) {
          return yield* listUsers({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        listGroups: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.listGroups(${pool.LogicalId})`,
        )(function* (request: ListGroupsRequest = {}) {
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
