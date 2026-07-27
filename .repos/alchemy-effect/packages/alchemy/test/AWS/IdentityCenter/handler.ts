import * as IdentityCenter from "@/AWS/IdentityCenter";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class IdentityCenterBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "IdentityCenterBindingsFunction",
) {}

/**
 * Lambda fixture exercising every IdentityCenter runtime binding against the
 * account's (pre-enabled) Identity Center instance. Deploying this fixture
 * requires an enabled instance, so the E2E suite that drives it is gated
 * behind ALCHEMY_TEST_IDENTITY_CENTER=1 (see Bindings.test.ts).
 */
export default IdentityCenterBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const instance = yield* IdentityCenter.Instance("IdcInstance", {
      mode: "existing",
    });
    const group = yield* IdentityCenter.Group("IdcBindingsGroup", {
      identityStoreId: instance.identityStoreId,
      displayName: "alchemy-idc-bindings-group",
      description: "Group used by the IdentityCenter Bindings E2E fixture",
    });
    const permissionSet = yield* IdentityCenter.PermissionSet(
      "IdcBindingsPermissionSet",
      {
        instanceArn: instance.instanceArn,
        name: "AlchemyIdcBindings",
        description: "Permission set used by the Bindings E2E fixture",
        sessionDuration: "1 hour",
      },
    );

    // Identity Store data plane
    const createUser = yield* IdentityCenter.CreateUser(instance);
    const updateUser = yield* IdentityCenter.UpdateUser(instance);
    const deleteUser = yield* IdentityCenter.DeleteUser(instance);
    const describeUser = yield* IdentityCenter.DescribeUser(instance);
    const getUserId = yield* IdentityCenter.GetUserId(instance);
    const listUsers = yield* IdentityCenter.ListUsers(instance);
    const getGroupId = yield* IdentityCenter.GetGroupId(instance);
    const listGroups = yield* IdentityCenter.ListGroups(instance);
    const createGroupMembership =
      yield* IdentityCenter.CreateGroupMembership(instance);
    const deleteGroupMembership =
      yield* IdentityCenter.DeleteGroupMembership(instance);
    const describeGroupMembership =
      yield* IdentityCenter.DescribeGroupMembership(instance);
    const getGroupMembershipId =
      yield* IdentityCenter.GetGroupMembershipId(instance);
    const listGroupMemberships =
      yield* IdentityCenter.ListGroupMemberships(instance);
    const listGroupMembershipsForMember =
      yield* IdentityCenter.ListGroupMembershipsForMember(instance);
    const isMemberInGroups = yield* IdentityCenter.IsMemberInGroups(instance);

    // sso-admin audit reads
    const listAccountAssignments =
      yield* IdentityCenter.ListAccountAssignments(instance);
    const listAccountAssignmentsForPrincipal =
      yield* IdentityCenter.ListAccountAssignmentsForPrincipal(instance);
    const listAccountsForProvisionedPermissionSet =
      yield* IdentityCenter.ListAccountsForProvisionedPermissionSet(instance);
    const listPermissionSets =
      yield* IdentityCenter.ListPermissionSets(instance);
    const describePermissionSet =
      yield* IdentityCenter.DescribePermissionSet(instance);

    const groupId = yield* group.groupId;
    const permissionSetArn = yield* permissionSet.permissionSetArn;

    const bound = {
      createUser,
      updateUser,
      deleteUser,
      describeUser,
      getUserId,
      listUsers,
      getGroupId,
      listGroups,
      createGroupMembership,
      deleteGroupMembership,
      describeGroupMembership,
      getGroupMembershipId,
      listGroupMemberships,
      listGroupMembershipsForMember,
      isMemberInGroups,
      listAccountAssignments,
      listAccountAssignmentsForPrincipal,
      listAccountsForProvisionedPermissionSet,
      listPermissionSets,
      describePermissionSet,
    };

    const TEST_USER_NAME = "alchemy-idc-bindings-user";

    /**
     * distilled types Identity Store PII (user names, display names) as
     * sensitive (`string | Redacted<string>`); unwrap before JSON-encoding
     * so the E2E assertions see the plain value.
     */
    const unwrap = (
      value: string | Redacted.Redacted<string> | undefined,
    ): string | undefined =>
      Redacted.isRedacted(value) ? Redacted.value(value) : value;

    /**
     * Create the deterministic test user, tolerating a leftover from a
     * previously crashed run by resolving the existing user's id instead.
     */
    const ensureTestUser = Effect.gen(function* () {
      const created = yield* Effect.result(
        createUser({
          UserName: TEST_USER_NAME,
          DisplayName: "Alchemy Bindings Test User",
          Name: { GivenName: "Alchemy", FamilyName: "Test" },
          Emails: [{ Value: "alchemy-idc-test@example.com", Primary: true }],
        }),
      );
      if (Result.isSuccess(created) && created.success.UserId) {
        return created.success.UserId;
      }
      const { UserId } = yield* getUserId({
        AlternateIdentifier: {
          UniqueAttribute: {
            AttributePath: "userName",
            AttributeValue: TEST_USER_NAME,
          },
        },
      });
      return UserId!;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/groups") {
          const { Groups } = yield* listGroups({ MaxResults: 50 });
          return yield* HttpServerResponse.json({
            displayNames: (Groups ?? []).map((g) => unwrap(g.DisplayName)),
          });
        }

        if (request.method === "GET" && pathname === "/users") {
          const { Users } = yield* listUsers({ MaxResults: 50 });
          return yield* HttpServerResponse.json({
            userNames: (Users ?? []).map((u) => unwrap(u.UserName)),
          });
        }

        if (request.method === "GET" && pathname === "/group-id") {
          const { GroupId } = yield* getGroupId({
            AlternateIdentifier: {
              UniqueAttribute: {
                AttributePath: "displayName",
                AttributeValue: "alchemy-idc-bindings-group",
              },
            },
          });
          return yield* HttpServerResponse.json({
            groupId: GroupId,
            matchesBoundGroup: GroupId === (yield* groupId),
          });
        }

        // Full user lifecycle: create -> getUserId -> describe -> update ->
        // describe -> delete. Deterministic user name; a leftover user from
        // a crashed run is adopted instead of failing.
        if (request.method === "POST" && pathname === "/user-roundtrip") {
          const userId = yield* ensureTestUser;
          const { UserId: resolvedId } = yield* getUserId({
            AlternateIdentifier: {
              UniqueAttribute: {
                AttributePath: "userName",
                AttributeValue: TEST_USER_NAME,
              },
            },
          });
          const before = yield* describeUser({ UserId: userId });
          yield* updateUser({
            UserId: userId,
            Operations: [
              {
                AttributePath: "displayName",
                AttributeValue: "Alchemy Bindings Test User (updated)",
              },
            ],
          });
          const after = yield* describeUser({ UserId: userId });
          yield* deleteUser({ UserId: userId });
          return yield* HttpServerResponse.json({
            userId,
            resolvedMatches: resolvedId === userId,
            userName: unwrap(before.UserName),
            displayNameBefore: unwrap(before.DisplayName),
            displayNameAfter: unwrap(after.DisplayName),
          });
        }

        // Full membership lifecycle against the fixture group: create user,
        // add to group, resolve/describe/query the membership, check
        // isMemberInGroups, then tear everything down.
        if (request.method === "POST" && pathname === "/membership-roundtrip") {
          const GroupId = yield* groupId;
          const userId = yield* ensureTestUser;
          const { MembershipId } = yield* createGroupMembership({
            GroupId,
            MemberId: { UserId: userId },
          });
          const resolved = yield* getGroupMembershipId({
            GroupId,
            MemberId: { UserId: userId },
          });
          const described = yield* describeGroupMembership({
            MembershipId: MembershipId!,
          });
          const members = yield* listGroupMemberships({ GroupId });
          const groupsOfUser = yield* listGroupMembershipsForMember({
            MemberId: { UserId: userId },
          });
          const check = yield* isMemberInGroups({
            MemberId: { UserId: userId },
            GroupIds: [GroupId],
          });
          yield* deleteGroupMembership({ MembershipId: MembershipId! });
          const checkAfter = yield* isMemberInGroups({
            MemberId: { UserId: userId },
            GroupIds: [GroupId],
          });
          yield* deleteUser({ UserId: userId });
          return yield* HttpServerResponse.json({
            membershipId: MembershipId,
            resolvedMatches: resolved.MembershipId === MembershipId,
            describedGroupMatches: described.GroupId === GroupId,
            memberCount: (members.GroupMemberships ?? []).length,
            memberOfCount: (groupsOfUser.GroupMemberships ?? []).length,
            isMember: check.Results?.[0]?.MembershipExists === true,
            isMemberAfterDelete:
              checkAfter.Results?.[0]?.MembershipExists === true,
          });
        }

        if (request.method === "GET" && pathname === "/permission-sets") {
          const arn = yield* permissionSetArn;
          const { PermissionSets } = yield* listPermissionSets({
            MaxResults: 100,
          });
          const { PermissionSet } = yield* describePermissionSet({
            PermissionSetArn: arn,
          });
          const { AccountIds } = yield* listAccountsForProvisionedPermissionSet(
            {
              PermissionSetArn: arn,
            },
          );
          return yield* HttpServerResponse.json({
            containsFixturePermissionSet: (PermissionSets ?? []).includes(arn),
            name: PermissionSet?.Name,
            sessionDuration: PermissionSet?.SessionDuration,
            provisionedAccounts: AccountIds ?? [],
          });
        }

        // Assignment audit reads. `listAccountAssignmentsForPrincipal` is
        // only valid on organization instances (from the management
        // account), so its failure tag is reported rather than crashing the
        // route. `listAccountAssignments` needs a target account id, passed
        // as ?accountId=.
        if (request.method === "GET" && pathname === "/assignments") {
          const GroupId = yield* groupId;
          const arn = yield* permissionSetArn;
          const forPrincipal = yield* Effect.result(
            listAccountAssignmentsForPrincipal({
              PrincipalId: GroupId,
              PrincipalType: "GROUP",
            }),
          );
          const accountId = url.searchParams.get("accountId");
          const direct = accountId
            ? yield* Effect.result(
                listAccountAssignments({
                  AccountId: accountId,
                  PermissionSetArn: arn,
                }),
              )
            : undefined;
          return yield* HttpServerResponse.json({
            forPrincipal: Result.isSuccess(forPrincipal)
              ? {
                  ok: true,
                  count: (forPrincipal.success.AccountAssignments ?? []).length,
                }
              : { ok: false, errorTag: forPrincipal.failure._tag },
            direct:
              direct === undefined
                ? undefined
                : Result.isSuccess(direct)
                  ? {
                      ok: true,
                      count: (direct.success.AccountAssignments ?? []).length,
                    }
                  : { ok: false, errorTag: direct.failure._tag },
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IdentityCenter.CreateUserHttp,
        IdentityCenter.UpdateUserHttp,
        IdentityCenter.DeleteUserHttp,
        IdentityCenter.DescribeUserHttp,
        IdentityCenter.GetUserIdHttp,
        IdentityCenter.ListUsersHttp,
        IdentityCenter.GetGroupIdHttp,
        IdentityCenter.ListGroupsHttp,
        IdentityCenter.CreateGroupMembershipHttp,
        IdentityCenter.DeleteGroupMembershipHttp,
        IdentityCenter.DescribeGroupMembershipHttp,
        IdentityCenter.GetGroupMembershipIdHttp,
        IdentityCenter.ListGroupMembershipsHttp,
        IdentityCenter.ListGroupMembershipsForMemberHttp,
        IdentityCenter.IsMemberInGroupsHttp,
        IdentityCenter.ListAccountAssignmentsHttp,
        IdentityCenter.ListAccountAssignmentsForPrincipalHttp,
        IdentityCenter.ListAccountsForProvisionedPermissionSetHttp,
        IdentityCenter.ListPermissionSetsHttp,
        IdentityCenter.DescribePermissionSetHttp,
      ),
    ),
  ),
);
