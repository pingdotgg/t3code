import * as AWS from "@/AWS";
import { Permission } from "@/AWS/RAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ram from "@distilled.cloud/aws/ram";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class PermissionStillLive extends Data.TaggedError("PermissionStillLive") {}

const readPermission = Effect.fn(function* (arn: string) {
  const detail = yield* ram.getPermission({ permissionArn: arn }).pipe(
    Effect.map((r) => r.permission),
    Effect.catchTag("UnknownResourceException", () =>
      Effect.succeed(undefined),
    ),
  );
  return detail && detail.status !== "DELETING" && detail.status !== "DELETED"
    ? detail
    : undefined;
});

const assertDeleted = Effect.fn(function* (arn: string) {
  yield* readPermission(arn).pipe(
    Effect.flatMap((p) =>
      p === undefined ? Effect.void : Effect.fail(new PermissionStillLive()),
    ),
    Effect.retry({
      while: (e) => e instanceof PermissionStillLive,
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(15)]),
    }),
  );
});

const permissionStack = (props: {
  actions: string[];
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const permission = yield* Permission("TestPermission", {
      resourceType: "appsync:Apis",
      policyTemplate: { actions: props.actions },
      tags: props.tags,
    });
    return { permission };
  });

test.provider(
  "create, publish new policy version, update tags, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Create a least-privilege AppSync API permission (appsync:Apis is
      //    one of the resource types supporting customer managed permissions).
      const { permission } = yield* stack.deploy(
        permissionStack({
          actions: ["appsync:SourceGraphQL"],
          tags: { team: "platform" },
        }),
      );

      expect(permission.permissionArn).toMatch(/^arn:aws:ram:/);
      expect(permission.resourceType).toBe("appsync:Apis");
      const arn = permission.permissionArn;
      const initialVersion = permission.version;

      // 2. Out-of-band: the permission is ATTACHABLE with our policy + tags.
      const live = yield* readPermission(arn);
      expect(live?.status).toBe("ATTACHABLE");
      const policy = JSON.parse(live?.permission ?? "{}") as {
        Action?: string | string[];
      };
      expect(policy.Action).toContain("appsync:SourceGraphQL");
      expect(
        live?.tags?.some((t) => t.key === "team" && t.value === "platform"),
      ).toBe(true);
      expect(live?.tags?.some((t) => t.key === "alchemy::id")).toBe(true);

      // 3. Update in place: grow the policy (new default version), add a
      //    tag. ARN is stable; the default version advances.
      const { permission: updated } = yield* stack.deploy(
        permissionStack({
          actions: ["appsync:SourceGraphQL", "appsync:GraphQL"],
          tags: { team: "platform", env: "prod" },
        }),
      );
      expect(updated.permissionArn).toEqual(arn);
      expect(updated.version).not.toEqual(initialVersion);

      // 4. Out-of-band: the default version carries the grown policy and
      //    the new tag; the superseded version was cleaned up.
      const live2 = yield* readPermission(arn);
      const policy2 = JSON.parse(live2?.permission ?? "{}") as {
        Action?: string | string[];
      };
      expect(policy2.Action).toContain("appsync:GraphQL");
      expect(
        live2?.tags?.some((t) => t.key === "env" && t.value === "prod"),
      ).toBe(true);

      // listPermissionVersions keeps DELETED versions in the listing — only
      // the new default remains live.
      const versions = yield* ram
        .listPermissionVersions({ permissionArn: arn })
        .pipe(Effect.map((r) => r.permissions ?? []));
      const liveVersions = versions.filter(
        (v) => v.status !== "DELETED" && v.status !== "DELETING",
      );
      expect(liveVersions).toHaveLength(1);
      expect(liveVersions[0]?.version).toEqual(updated.version);

      // 5. Re-deploy with identical props: a no-op — no new version.
      const { permission: same } = yield* stack.deploy(
        permissionStack({
          actions: ["appsync:SourceGraphQL", "appsync:GraphQL"],
          tags: { team: "platform", env: "prod" },
        }),
      );
      expect(same.version).toEqual(updated.version);

      // 6. Delete and confirm gone.
      yield* stack.destroy();
      yield* assertDeleted(arn);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed permission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { permission } = yield* stack.deploy(
        permissionStack({ actions: ["appsync:SourceGraphQL"] }),
      );

      const provider = yield* Provider.findProvider(Permission);
      const all = yield* provider.list();
      expect(
        all.some((x) => x.permissionArn === permission.permissionArn),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertDeleted(permission.permissionArn);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
