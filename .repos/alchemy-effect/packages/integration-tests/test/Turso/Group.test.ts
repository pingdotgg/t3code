import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Turso from "@alchemy.run/turso";
import { organization } from "@alchemy.run/turso/Credentials";
import * as turso from "@distilled.cloud/turso/turso";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Turso.providers() });

const expectGroupGone = (name: string) =>
  Effect.gen(function* () {
    const org = yield* organization;
    const found = yield* turso.getGroup({ organizationSlug: org, groupName: name }).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (exists) => !exists,
        times: 10,
      }),
    );
    expect(found).toBe(false);
  });

test.provider(
  "create, update delete protection, and delete a group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Turso.Group("Group", { location: "aws-us-east-1" });
        }),
      );
      expect(group.location).toBe("aws-us-east-1");
      expect(group.locations).toEqual(["aws-us-east-1"]);
      expect(group.deleteProtection).toBe(false);
      expect(group.organization).toBe(org);

      const observed = yield* turso.getGroup({ organizationSlug: org, groupName: group.name });
      expect(observed.group?.uuid).toBe(group.uuid);

      const protectedGroup = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Turso.Group("Group", {
            location: "aws-us-east-1",
            deleteProtection: true,
          });
        }),
      );
      expect(protectedGroup.uuid).toBe(group.uuid);
      expect(protectedGroup.deleteProtection).toBe(true);
      const config = yield* turso.getGroupConfiguration({
        organizationSlug: org,
        groupName: group.name,
      });
      expect(config.delete_protection).toBe(true);

      // Turn protection back off so the group can be destroyed.
      const unprotected = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Turso.Group("Group", { location: "aws-us-east-1" });
        }),
      );
      expect(unprotected.deleteProtection).toBe(false);

      yield* stack.destroy();
      yield* expectGroupGone(group.name);
    }),
  { tags: ["provider:turso", "provider:turso:group", "live"], timeout: 120_000 },
);

test.provider(
  "changing the location replaces the group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const east = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Turso.Group("Moving", { location: "aws-us-east-1" });
        }),
      );
      const west = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Turso.Group("Moving", { location: "aws-us-west-2" });
        }),
      );
      expect(west.location).toBe("aws-us-west-2");
      expect(west.uuid).not.toBe(east.uuid);
      expect(west.name).not.toBe(east.name);
      yield* expectGroupGone(east.name);

      yield* stack.destroy();
      yield* expectGroupGone(west.name);
    }),
  { tags: ["provider:turso", "provider:turso:group", "live"], timeout: 120_000 },
);

test.provider(
  "adding a replica location on an AWS group fails with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Turso.Group("Replicated", {
              location: "aws-us-east-1",
              replicas: ["aws-us-west-2"],
            });
          }),
        )
        .pipe(Effect.flip);
      expect(String(result)).toContain("replication is not supported");
      yield* stack.destroy();
    }),
  { tags: ["provider:turso", "provider:turso:group", "live"], timeout: 120_000 },
);

const pinned = (suffix: string) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    return `alchemy-${stage}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  });

test.provider(
  "changing the location of a group with a pinned name deletes the old one first",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* pinned("pinned-group");

      const east = yield* stack.deploy(Turso.Group("Pinned", { name, location: "aws-us-east-1" }));
      const west = yield* stack.deploy(Turso.Group("Pinned", { name, location: "aws-us-west-2" }));
      expect(west.name).toBe(name);
      expect(west.location).toBe("aws-us-west-2");
      expect(west.uuid).not.toBe(east.uuid);

      yield* stack.destroy();
      yield* expectGroupGone(name);
    }),
  { tags: ["provider:turso", "provider:turso:group", "live"], timeout: 120_000 },
);

test.provider(
  "a group with a pinned name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const name = yield* pinned("foreign-group");
      yield* turso
        .deleteGroup({ organizationSlug: org, groupName: name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      const foreign = yield* turso.createGroup({
        organizationSlug: org,
        name,
        location: "aws-us-east-1",
      });

      const app = (allow: boolean) =>
        Turso.Group("Foreign", { name, location: "aws-us-east-1" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.uuid).toBe(foreign.group?.uuid);

      yield* stack.destroy();
      yield* expectGroupGone(name);
    }),
  { tags: ["provider:turso", "provider:turso:group", "live"], timeout: 120_000 },
);
