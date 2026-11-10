import { Branch } from "@alchemy.run/neon/Branch";
import type { PostgresOrigin } from "@alchemy.run/neon/PostgresOrigin";
import { Project, waitForOperations } from "@alchemy.run/neon/Project";
import { providers } from "@alchemy.run/neon/Providers";
import { Role } from "@alchemy.run/neon/Role";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { createProjectBranchRole, getProjectBranchRole } from "@distilled.cloud/neon";
import * as PgClient from "@effect/sql-pg/PgClient";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: providers() });

const tags = ["provider:neon", "provider:neon:role", "live"];

/** Log in as the role and return `current_user`. */
const currentUser = Effect.fn(
  function* (_origin: PostgresOrigin, _user: string, _password: Redacted.Redacted<string>) {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ user: string }>`select current_user as user`;
    return rows[0]?.user;
  },
  (effect, origin, user, password) =>
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          host: origin.host,
          port: origin.port,
          database: origin.database,
          username: user,
          password,
          ssl: true,
        }),
      ),
    ),
);

const roleExists = (scope: { projectId: string; branchId: string }, roleName: string) =>
  getProjectBranchRole({
    project_id: scope.projectId,
    branch_id: scope.branchId,
    role_name: roleName,
  }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

describe.concurrent("Neon.Role", { tags }, () => {
  test.provider(
    "creates a login role, keeps its password, replaces on noLogin, and deletes",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (noLogin?: boolean) =>
          Effect.gen(function* () {
            const project = yield* Project("RoleProject");
            const branch = yield* Branch("RoleBranch", { project });
            const role = yield* Role("AppRole", { branch, noLogin });
            return { branch, role };
          });

        const { branch, role } = yield* stack.deploy(program());
        expect(role.roleName).toMatch(/^[a-z0-9_]+$/);
        expect(role.noLogin).toBe(false);
        expect(role.password).toBeDefined();
        expect(yield* currentUser(branch.origin, role.roleName, role.password!)).toBe(
          role.roleName,
        );

        // An unchanged redeploy keeps the same password.
        expect((yield* stack.plan(program())).resources.AppRole.action).toBe("noop");
        const redeployed = yield* stack.deploy(program());
        expect(Redacted.value(redeployed.role.password!)).toBe(Redacted.value(role.password!));

        // noLogin is creation-only; a generated name gets a new role, created first.
        const groupPlan = yield* stack.plan(program(true));
        expect(groupPlan.resources.AppRole).toMatchObject({
          action: "replace",
          deleteFirst: false,
        });
        const group = yield* stack.deploy(program(true));
        expect(group.role.roleName).not.toBe(role.roleName);
        expect(group.role.noLogin).toBe(true);
        expect(group.role.password).toBeUndefined();
        expect(yield* roleExists(role, role.roleName)).toBe(false);

        yield* stack.destroy();
        expect(yield* roleExists(group.role, group.role.roleName)).toBe(false);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "renames an explicit role on the project's default branch and replaces it delete-first",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (name: string, noLogin?: boolean) =>
          Effect.gen(function* () {
            const project = yield* Project("RoleDefaultProject");
            const role = yield* Role("Migrator", { project, name, noLogin });
            return { project, role };
          });
        const first = yield* stack.deploy(program("migrator"));
        expect(first.role.branchId).toBe(first.project.defaultBranchId);
        expect(first.role.roleName).toBe("migrator");

        const renamed = yield* stack.deploy(program("migrator_v2"));
        expect(renamed.role.roleName).toBe("migrator_v2");
        expect(yield* roleExists(first.role, "migrator")).toBe(false);
        expect(
          yield* currentUser(first.project.origin, "migrator_v2", renamed.role.password!),
        ).toBe("migrator_v2");

        // The same explicit name must be freed before the replacement is created.
        expect((yield* stack.plan(program("migrator_v2", true))).resources.Migrator).toMatchObject({
          action: "replace",
          deleteFirst: true,
        });
        const group = yield* stack.deploy(program("migrator_v2", true));
        expect(group.role.roleName).toBe("migrator_v2");
        expect(group.role.noLogin).toBe(true);

        yield* stack.destroy();
        expect(yield* roleExists(first.role, "migrator_v2")).toBe(false);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "refuses a foreign role until adopted, then reveals its existing password",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const base = Project("RoleAdoptProject");
        const project = yield* stack.deploy(base);
        const foreign = yield* createProjectBranchRole({
          project_id: project.projectId,
          branch_id: project.defaultBranchId,
          role: { name: "foreign_role" },
        });
        yield* waitForOperations(foreign.operations);
        const program = (allow: boolean) =>
          Effect.gen(function* () {
            const project = yield* base;
            return yield* Role("ForeignRole", { project, name: "foreign_role" }).pipe(adopt(allow));
          });

        const refused = yield* stack.deploy(program(false)).pipe(Effect.result);
        expect(Result.isFailure(refused)).toBe(true);
        if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

        const adopted = yield* stack.deploy(program(true));
        const foreignPassword = foreign.role.password!;
        expect(Redacted.value(adopted.password!)).toBe(
          Redacted.isRedacted(foreignPassword) ? Redacted.value(foreignPassword) : foreignPassword,
        );
        expect(yield* currentUser(project.origin, "foreign_role", adopted.password!)).toBe(
          "foreign_role",
        );

        yield* stack.destroy();
      }),
    { timeout: 180_000 },
  );
});
