import * as Neon from "@distilled.cloud/neon";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { resolveBranchScope, type BranchScope, type ResolvedBranchScope } from "./BranchScope.ts";
import { waitForOperations } from "./Project.ts";
import type { Providers } from "./Providers.ts";

export type RoleProps = BranchScope & {
  /**
   * Postgres role name, at most 63 bytes. Omit to generate a unique,
   * lowercase name. Changing an explicit name replaces the role.
   */
  name?: string;
  /**
   * Create a role that cannot log in, for example a group role that owns
   * objects and is granted to login roles with SQL. Changes replace the role.
   * @default false
   */
  noLogin?: boolean;
};

export interface RoleAttributes extends ResolvedBranchScope {
  /** Postgres role name. */
  roleName: string;
  /** Role password; `undefined` for a role created with `noLogin`. */
  password: Redacted.Redacted<string> | undefined;
  /** Whether the role cannot log in. */
  noLogin: boolean;
  /** Authentication method reported by Neon: `password`, `oauth`, or `no_login`. */
  authenticationMethod: string | undefined;
  /** Creation time. */
  createdAt: string;
}

export interface Role extends Resource<"Neon.Role", RoleProps, RoleAttributes, never, Providers> {}

/**
 * A Postgres role on a Neon branch. Neon makes every role it creates a
 * member of `neon_superuser`: it can read and write all data, create
 * databases and roles, and bypass row-level security. Use roles for
 * separate logins and passwords, not to restrict access.
 *
 * ### Creating a Role
 * **Example:** A login role on a branch
 * ```typescript
 * const app = yield* Neon.Role("App", { branch });
 * // app.roleName and app.password (Redacted) connect to branch.origin.host
 * ```
 *
 * **Example:** A role on the project's default branch
 * ```typescript
 * const migrator = yield* Neon.Role("Migrator", { project, name: "migrator" });
 * ```
 *
 * ### Group Roles
 * **Example:** A role that cannot log in
 * ```typescript
 * const owner = yield* Neon.Role("Owner", { branch, name: "app_owner", noLogin: true });
 * ```
 *
 * @resource
 * @product Role
 */
export const Role = Resource<Role>("Neon.Role");

const requestScope = (scope: ResolvedBranchScope) => ({
  project_id: scope.projectId,
  branch_id: scope.branchId,
});

const redact = (password: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(password) ? password : Redacted.make(password);

// Underscores keep generated names usable unquoted in SQL (`GRANT ... TO app_xyz`).
const createRoleName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    const generated = yield* createPhysicalName({ id, maxLength: 63, lowercase: true });
    return generated.replaceAll("-", "_");
  });

const observeRole = Effect.fn(function* (scope: ResolvedBranchScope, roleName: string) {
  return yield* Neon.getProjectBranchRole({ ...requestScope(scope), role_name: roleName }).pipe(
    Effect.map(({ role }) => role),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );
});

const isNoLogin = (role: Neon.Role) => role.authentication_method === "no_login";

/** Read a login role's stored password, resetting it when Neon no longer has it. */
const revealPassword = Effect.fn(function* (scope: ResolvedBranchScope, role: Neon.Role) {
  if (isNoLogin(role)) return undefined;
  const request = { ...requestScope(scope), role_name: role.name };
  const stored = yield* Neon.getProjectBranchRolePassword(request).pipe(
    Effect.map(({ password }) => redact(password)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );
  if (stored) return stored;
  const reset = yield* Neon.resetProjectBranchRolePassword(request);
  yield* waitForOperations(reset.operations);
  return reset.role.password === undefined ? undefined : redact(reset.role.password);
});

const toAttributes = (
  scope: ResolvedBranchScope,
  role: Neon.Role,
  password: Redacted.Redacted<string> | undefined,
): RoleAttributes => ({
  ...scope,
  roleName: role.name,
  password,
  noLogin: isNoLogin(role),
  authenticationMethod: role.authentication_method,
  createdAt: role.created_at,
});

export const RoleProvider = () =>
  Provider.succeed(Role, {
    stables: ["projectId", "branchId", "roleName"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || !output) return;
      const scope = yield* resolveBranchScope(news);
      const sameScope = scope.projectId === output.projectId && scope.branchId === output.branchId;
      if (
        !sameScope ||
        (news.name !== undefined && news.name !== output.roleName) ||
        (news.noLogin ?? false) !== output.noLogin
      ) {
        return {
          action: "replace",
          // A generated name changes with the new instance; only an explicit,
          // unchanged name must free itself before the replacement is created.
          deleteFirst: sameScope && news.name !== undefined && news.name === output.roleName,
        };
      }
    }),
    read: Effect.fn(function* ({ id, olds, output, previous }) {
      if (!output && !olds?.branch && !olds?.project) return undefined;
      const scope = output ?? (yield* resolveBranchScope(olds!));
      const roleName = output?.roleName ?? (yield* createRoleName(id, olds?.name));
      const role = yield* observeRole(scope, roleName);
      if (!role) return undefined;
      if (output) return toAttributes(scope, role, output.password);
      // The generation a delete-first replacement is about to free.
      if (
        previous?.projectId === scope.projectId &&
        previous.branchId === scope.branchId &&
        previous.roleName === role.name
      ) {
        return toAttributes(scope, role, previous.password);
      }
      // Only an explicit name can collide with a role this stack did not create.
      const attrs = toAttributes(scope, role, yield* revealPassword(scope, role));
      return olds?.name !== undefined ? Unowned(attrs) : attrs;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveBranchScope(news);
      const roleName = news.name ?? output?.roleName ?? (yield* createRoleName(id, undefined));
      const existing = yield* observeRole(scope, roleName);
      if (!existing) {
        const created = yield* Neon.createProjectBranchRole({
          ...requestScope(scope),
          role: { name: roleName, ...(news.noLogin ? { no_login: true } : {}) },
        }).pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (created) {
          yield* waitForOperations(created.operations);
          return toAttributes(
            scope,
            created.role,
            created.role.password === undefined ? undefined : redact(created.role.password),
          );
        }
      }
      // An existing role: keep the password we already hold, otherwise reveal it.
      const role =
        existing ??
        (yield* Neon.getProjectBranchRole({
          ...requestScope(scope),
          role_name: roleName,
        })).role;
      const password =
        output?.roleName === role.name && output.password !== undefined
          ? output.password
          : yield* revealPassword(scope, role);
      return toAttributes(scope, role, password);
    }),
    delete: Effect.fn(function* ({ output }) {
      const deleted = yield* Neon.deleteProjectBranchRole({
        ...requestScope(output),
        role_name: output.roleName,
      }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (deleted) yield* waitForOperations(deleted.operations);
    }),
  });
