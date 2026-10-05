import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import { defaultProviderMode } from "../ProviderMode.ts";
import type { ResourceLike } from "../Resource.ts";
import {
  CurrentRuntimeContext,
  type RuntimeContext,
} from "../RuntimeContext.ts";
import type { Branch } from "./Branch.ts";
import { resolveBranchScope } from "./BranchScope.ts";
import type { Function } from "./Function.ts";
import type { Project } from "./Project.ts";

/** Postgres connection accessors. Resolving these Effects does not acquire a socket or pool. */
export interface ConnectClient {
  /** Pooled URL for ordinary application queries. */
  connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  >;
  /** Pooled URL, including Neon's pooler hostname. */
  pooledConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  >;
  /** Direct URL for migrations, notifications, and session-oriented clients. */
  directConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  >;
}

/**
 * Connect to a Branch or a Project's default database from a Function, Worker,
 * Lambda, or another Platform host. Same-branch Neon Functions use the injected
 * `DATABASE_URL` and `DATABASE_URL_UNPOOLED`; local Functions and other hosts
 * receive namespaced database secrets, never the deployment account API key.
 *
 * Accessors are lazy and redacted. `SQL.Postgres` and `Drizzle.Postgres` create
 * their connections in request scope, not when this binding is initialized.
 *
 * ### Querying Postgres
 * **Example:** Bind a database to an Effect host
 * ```typescript
 * Effect.gen(function* () {
 *   const db = yield* Neon.Connect(branch);
 *   const sql = yield* SQL.Postgres({ url: db.connectionString });
 *   return { fetch: Effect.gen(function* () {
 *     return yield* HttpServerResponse.json(yield* sql`SELECT 1 AS value`);
 *   }) };
 * }).pipe(Effect.provide(Neon.ConnectHttp));
 * ```
 *
 * ### Native applications
 * **Example:** Explicit environment for a native cross-branch Function
 * ```typescript
 * const api = yield* Neon.Function("Api", {
 *   branch: applicationBranch,
 *   main: "./api.ts",
 *   env: Neon.connectEnv(databaseBranch),
 * });
 * ```
 *
 * Native same-branch Neon Functions already have `DATABASE_URL` and
 * `DATABASE_URL_UNPOOLED` and need no binding. `connectEnvKeys` gives native
 * applications the names used by `connectEnv` for cross-host connections.
 *
 * @binding
 * @product Branch
 */
export interface Connect extends Binding.Service<
  Connect,
  "Neon.Connect",
  (database: Branch | Project) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>("Neon.Connect");

/** Stable, collision-free environment names for native cross-host consumers. */
export const connectEnvKeys = (database: Pick<Branch | Project, "FQN">) => {
  const name = Array.from(database.FQN, (character) =>
    character.codePointAt(0)!.toString(16),
  ).join("_");
  const prefix = `NEON_${name}`;
  return {
    injected: `${prefix}_INJECTED`,
    pooledConnectionString: `${prefix}_DATABASE_URL`,
    directConnectionString: `${prefix}_DATABASE_URL_UNPOOLED`,
  };
};

/** Redacted environment outputs for native hosts. No deployment credentials are included. */
export const connectEnv = (database: Branch | Project) => {
  const keys = connectEnvKeys(database);
  return {
    [keys.pooledConnectionString]: database.pooledConnectionUri.pipe(
      Output.map(Redacted.make),
    ),
    [keys.directConnectionString]: database.connectionUri.pipe(
      Output.map(Redacted.make),
    ),
  };
};

const isFunction = (host: ResourceLike | undefined): host is Function =>
  host?.Type === "Neon.Function";
const stringOutput = (value: string | Output.Output<string>) =>
  typeof value === "string" ? Output.literal(value) : value;

const injectedScope = (
  host: ResourceLike | undefined,
  database: Branch | Project,
) => {
  if (!isFunction(host)) return Output.literal(false);
  const scope = host.Props;
  const targetBranch =
    database.Type === "Neon.Branch"
      ? database.branchId
      : database.defaultBranchId;
  if (scope.branch) {
    return Output.all(
      stringOutput(scope.branch.projectId),
      stringOutput(scope.branch.branchId),
      database.projectId,
      targetBranch,
    ).pipe(
      Output.map(
        ([project, branch, targetProject, target]) =>
          project === targetProject && branch === target,
      ),
    );
  }
  if (scope.project) {
    const resolved = stringOutput(scope.project.projectId).pipe(
      Output.mapEffect((projectId: string) =>
        resolveBranchScope({ project: { projectId } }).pipe(Effect.orDie),
      ),
    );
    return Output.all(
      resolved.projectId,
      resolved.branchId,
      database.projectId,
      targetBranch,
    ).pipe(
      Output.map(
        ([project, branch, targetProject, target]) =>
          project === targetProject && branch === target,
      ),
    );
  }
  return Output.literal(false);
};

/** Host-independent implementation using Platform's common environment channel. */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const context = yield* CurrentRuntimeContext;
    if (!context)
      return yield* Effect.die(
        new Error("Neon.Connect requires a Platform host"),
      );
    return Effect.fn(function* (database: Branch | Project) {
      const keys = connectEnvKeys(database);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        const mode = host?.Mode ?? (yield* defaultProviderMode);
        const injected =
          mode === "local"
            ? Output.literal(false)
            : injectedScope(host, database);
        yield* context.set(keys.injected, injected);
        yield* context.set(
          keys.pooledConnectionString,
          Output.all(injected, database.pooledConnectionUri).pipe(
            Output.map(([sameBranch, uri]) =>
              sameBranch ? "" : Redacted.make(uri),
            ),
          ),
        );
        yield* context.set(
          keys.directConnectionString,
          Output.all(injected, database.connectionUri).pipe(
            Output.map(([sameBranch, uri]) =>
              sameBranch ? "" : Redacted.make(uri),
            ),
          ),
        );
      }
      const connection = (key: string, injectedKey: string) =>
        Effect.gen(function* () {
          const injected = yield* context.get<boolean>(keys.injected);
          const value = yield* context.get<string | Redacted.Redacted<string>>(
            injected ? injectedKey : key,
          );
          if (value === undefined || value === "") {
            return yield* Effect.die(
              new Error(
                `Missing Neon database environment value: ${injected ? injectedKey : key}`,
              ),
            );
          }
          return Redacted.isRedacted(value) ? value : Redacted.make(value);
        });
      const pooledConnectionString = connection(
        keys.pooledConnectionString,
        "DATABASE_URL",
      );
      return {
        connectionString: pooledConnectionString,
        pooledConnectionString,
        directConnectionString: connection(
          keys.directConnectionString,
          "DATABASE_URL_UNPOOLED",
        ),
      } satisfies ConnectClient;
    });
  }),
);
