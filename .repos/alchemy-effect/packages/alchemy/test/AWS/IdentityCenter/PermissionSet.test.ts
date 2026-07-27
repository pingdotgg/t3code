import * as AWS from "@/AWS";
import { PermissionSet } from "@/AWS/IdentityCenter";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Requires an enabled IAM Identity Center (SSO) instance in the testing
// account. Without one, `resolveInstance` fails with:
//   Error: "Unable to resolve a single visible Identity Center instance;
//           pass instanceArn explicitly"
// The testing account is an ORGANIZATION MANAGEMENT account, where
// `CreateInstance` is rejected with a typed
//   ValidationException: "Organization management account is not allowed to
//                         perform the operation."
// and organization instances can only be enabled via the console — so an
// instance cannot be provisioned programmatically. Gate the live lifecycle
// behind ALCHEMY_TEST_IDENTITY_CENTER=1 so an entitled account runs it
// unchanged.
const SKIP_IDENTITY_CENTER = !process.env.ALCHEMY_TEST_IDENTITY_CENTER;

test.provider.skipIf(SKIP_IDENTITY_CENTER)(
  "lifecycle round-trips sessionDuration and list enumerates the set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with a string Duration.Input — must land on the wire as
      // the canonical ISO-8601 string.
      const permissionSet = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PermissionSet("ListPermissionSet", {
            name: "alchemy-test-list-permission-set",
            description: "list() coverage test",
            sessionDuration: "1 hour",
          });
        }),
      );

      expect(permissionSet.sessionDuration).toBe("PT1H");

      // Out-of-band wire verification via distilled.
      const described = yield* ssoAdmin.describePermissionSet({
        InstanceArn: permissionSet.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
      });
      expect(described.PermissionSet?.SessionDuration).toBe("PT1H");

      const provider = yield* Provider.findProvider(PermissionSet);
      const all = yield* provider.list();

      const found = all.find(
        (p) => p.permissionSetArn === permissionSet.permissionSetArn,
      );
      expect(found).toBeDefined();
      expect(found?.name).toBe(permissionSet.name);
      expect(found?.instanceArn).toBe(permissionSet.instanceArn);

      // Update with a Duration object — exercises the non-string
      // Duration.Input path and the updatePermissionSet sync branch.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PermissionSet("ListPermissionSet", {
            name: "alchemy-test-list-permission-set",
            description: "list() coverage test",
            sessionDuration: Duration.minutes(90),
          });
        }),
      );

      expect(updated.permissionSetArn).toBe(permissionSet.permissionSetArn);
      expect(updated.sessionDuration).toBe("PT1H30M");

      const redescribed = yield* ssoAdmin.describePermissionSet({
        InstanceArn: updated.instanceArn,
        PermissionSetArn: updated.permissionSetArn,
      });
      expect(redescribed.PermissionSet?.SessionDuration).toBe("PT1H30M");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
