import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { AccountAssignment, Group, PermissionSet } from "@/AWS/IdentityCenter";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Identity Center requires an enabled SSO instance / identity store in the
// testing account. If unavailable, `resolveInstance` fails with:
//   Error: "Unable to resolve a single visible Identity Center instance; pass instanceArn explicitly"
// The testing account is an organization management account where
// `CreateInstance` fails with a typed ValidationException ("Organization
// management account is not allowed to perform the operation."), so an
// instance cannot be provisioned programmatically. Gate the live list test
// behind ALCHEMY_TEST_IDENTITY_CENTER=1 so an entitled account runs it
// unchanged.
const SKIP_IDENTITY_CENTER = !process.env.ALCHEMY_TEST_IDENTITY_CENTER;

// Canonical `list()` test for an account assignment (a fan-out collection:
// instances -> permission sets -> accounts -> assignments). Deploy a real
// permission set + group + assignment targeting the current account, resolve
// the provider from context via the typed `findProvider`, call `list()`, and
// assert the deployed assignment appears in the exhaustively-paginated result.
test.provider.skipIf(SKIP_IDENTITY_CENTER)(
  "list enumerates the deployed account assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId } = yield* AWSEnvironment.current;

      const assignment = yield* stack.deploy(
        Effect.gen(function* () {
          const permissionSet = yield* PermissionSet("ListPermissionSet", {
            name: "alchemy-list-test-permission-set",
            description: "Permission set used to verify list() enumeration",
            sessionDuration: "1 hour",
          });

          const group = yield* Group("ListGroup", {
            displayName: "alchemy-list-assignment-group",
            description: "Group used to verify assignment list() enumeration",
          });

          return yield* AccountAssignment("ListAssignment", {
            permissionSetArn: permissionSet.permissionSetArn,
            principalType: "GROUP",
            principalId: group.groupId,
            targetId: accountId,
          });
        }),
      );

      const provider = yield* Provider.findProvider(AccountAssignment);
      const all = yield* provider.list();

      expect(
        all.some(
          (a) =>
            a.permissionSetArn === assignment.permissionSetArn &&
            a.principalId === assignment.principalId &&
            a.targetId === assignment.targetId,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
