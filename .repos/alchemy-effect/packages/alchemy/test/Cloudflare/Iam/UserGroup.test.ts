import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/cloudflare/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic names — the same on every run (never Date.now()/random).
const UG_NAME = "alchemy-iam-ug-crud";
const UG_NAME_RENAMED = "alchemy-iam-ug-crud-renamed";
const RG_NAME = "alchemy-iam-ug-crud-rg";

// Built-in permission groups looked up by their stable catalog names.
const PERMISSION_GROUP_NAME = "Page Rules Read";
const PERMISSION_GROUP_NAME_2 = "Security Center Read";

const findPermissionGroupId = (accountId: string, name: string) =>
  iam.listPermissionGroups.items({ accountId, name }).pipe(
    Stream.runHead,
    Effect.flatMap((pg) =>
      pg._tag === "Some"
        ? Effect.succeed(pg.value.id)
        : Effect.die(new Error(`permission group "${name}" not found`)),
    ),
  );

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getUserGroup = (accountId: string, userGroupId: string) =>
  iam.getUserGroup({ accountId, userGroupId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A destroyed user group answers GET with the typed `UserGroupNotFound`.
const expectGone = (accountId: string, userGroupId: string) =>
  getUserGroup(accountId, userGroupId).pipe(
    Effect.asSome,
    Effect.catchTag("UserGroupNotFound", () => Effect.succeedNone),
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: (g) => g._tag === "None",
      times: 8,
    }),
    Effect.map((g) => expect(g._tag).toEqual("None")),
  );

// One program deploying the resource group and the user group whose policy
// references it. The policy props reference the resource group's output, so
// the engine orders the user group after it on deploy (and before it on
// destroy).
const program = (opts: {
  name: string;
  permissionGroupId: string;
  accountScopeKey: string;
}) =>
  Effect.gen(function* () {
    const rg = yield* Cloudflare.Iam.ResourceGroup("Rg", {
      name: RG_NAME,
      scope: { key: opts.accountScopeKey, objects: [{ key: "*" }] },
    });
    const group = yield* Cloudflare.Iam.UserGroup("Group", {
      name: opts.name,
      policies: [
        {
          // Cloudflare rejects `deny` user-group policies ("Policy
          // validation failed") — only `allow` is exercised here.
          access: "allow",
          permissionGroups: [opts.permissionGroupId],
          resourceGroups: [rg.resourceGroupId],
        },
      ],
    });
    return { rg, group };
  });

test.provider(
  "create with a policy, verify out-of-band, update policies in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const accountScopeKey = `com.cloudflare.api.account.${accountId}`;
      const permissionGroupId = yield* findPermissionGroupId(
        accountId,
        PERMISSION_GROUP_NAME,
      );
      const permissionGroupId2 = yield* findPermissionGroupId(
        accountId,
        PERMISSION_GROUP_NAME_2,
      );

      yield* stack.destroy();

      // Create — one allow policy joining the permission group and the
      // resource group.
      const v1 = yield* stack.deploy(
        program({
          name: UG_NAME,
          permissionGroupId,
          accountScopeKey,
        }),
      );

      expect(v1.group.userGroupId).toBeTruthy();
      expect(v1.group.accountId).toEqual(accountId);
      expect(v1.group.name).toEqual(UG_NAME);
      expect(v1.group.createdOn).toBeTruthy();
      expect(v1.group.policies).toHaveLength(1);
      expect(v1.group.policies[0]!.access).toEqual("allow");
      expect(v1.group.policies[0]!.permissionGroups).toEqual([
        permissionGroupId,
      ]);
      expect(v1.group.policies[0]!.resourceGroups).toEqual([
        v1.rg.resourceGroupId,
      ]);

      // Out-of-band verification via the distilled API.
      const live = yield* getUserGroup(accountId, v1.group.userGroupId);
      expect(live.name).toEqual(UG_NAME);
      expect(live.policies ?? []).toHaveLength(1);
      expect(live.policies?.[0]?.access).toEqual("allow");

      // In-place update — rename and swap the policy's permission group.
      // Same user group (no replacement).
      const v2 = yield* stack.deploy(
        program({
          name: UG_NAME_RENAMED,
          permissionGroupId: permissionGroupId2,
          accountScopeKey,
        }),
      );

      expect(v2.group.userGroupId).toEqual(v1.group.userGroupId);
      expect(v2.group.name).toEqual(UG_NAME_RENAMED);
      expect(v2.group.policies[0]!.permissionGroups).toEqual([
        permissionGroupId2,
      ]);

      const updated = yield* getUserGroup(accountId, v2.group.userGroupId);
      expect(updated.name).toEqual(UG_NAME_RENAMED);
      expect(updated.policies?.[0]?.permissionGroups?.[0]?.id).toEqual(
        permissionGroupId2,
      );

      // No-op deploy — same desired state, same identity, reconcile
      // observes the in-sync state and applies nothing.
      const v3 = yield* stack.deploy(
        program({
          name: UG_NAME_RENAMED,
          permissionGroupId: permissionGroupId2,
          accountScopeKey,
        }),
      );
      expect(v3.group.userGroupId).toEqual(v1.group.userGroupId);

      yield* stack.destroy();

      yield* expectGone(accountId, v1.group.userGroupId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const UG_LIST_NAME = "alchemy-iam-ug-list";

test.provider(
  "list enumerates the deployed user group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Iam.UserGroup("ListGroup", {
            name: UG_LIST_NAME,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Iam.UserGroup);
      const all = yield* provider.list();

      // Exhaustively-paginated account collection contains the deployed
      // group, hydrated into the exact `read` Attributes shape.
      const found = all.find((g) => g.userGroupId === deployed.userGroupId);
      expect(found).toBeTruthy();
      expect(found!.name).toEqual(UG_LIST_NAME);
      expect(found!.accountId).toEqual(deployed.accountId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
