import * as AWS from "@/AWS";
import { Group } from "@/AWS/IdentityCenter";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Identity Center requires an enabled SSO instance / identity store in the
// testing account. If unavailable, `resolveIdentityStoreId` fails with:
//   Error: "Unable to resolve a single visible Identity Center instance; pass instanceArn explicitly"
// The testing account is an organization management account where
// `CreateInstance` fails with a typed ValidationException ("Organization
// management account is not allowed to perform the operation."), so an
// instance cannot be provisioned programmatically. Gate the live list test
// behind ALCHEMY_TEST_IDENTITY_CENTER=1 so an entitled account runs it
// unchanged.
const SKIP_IDENTITY_CENTER = !process.env.ALCHEMY_TEST_IDENTITY_CENTER;

// Canonical `list()` test (AWS account-scoped collection within the identity
// store): deploy a real group, resolve the provider from context via the typed
// `findProvider`, call `list()`, and assert the deployed group appears in the
// exhaustively-paginated result.
test.provider.skipIf(SKIP_IDENTITY_CENTER)(
  "list enumerates the deployed group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Group("ListGroup", {
            displayName: "alchemy-list-test-group",
            description: "Group used to verify list() enumeration",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Group);
      const all = yield* provider.list();

      expect(all.some((g) => g.groupId === group.groupId)).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
