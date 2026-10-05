import { Branch } from "@/Neon/Branch";
import type { PostgresOrigin } from "@/Neon/PostgresOrigin";
import { Project, type ProjectProps } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import { runSql, withPgClient } from "@/Neon/Migrations.ts";
import { makePgMigrationExecutor } from "@/SQL/Migrations/index.ts";
import * as Provider from "@/Provider";
import { hashMigrations } from "@/SQL/SqlFile.ts";
import * as Test from "@/Test/Alchemy";
import {
  createProject,
  deleteProject,
  getConnectionURI,
  getProject,
  updateProject,
} from "@distilled.cloud/neon";
import { adopt, OwnedBySomeoneElse, Unowned } from "@/AdoptPolicy";
import * as Result from "effect/Result";
import { waitForOperations } from "@/Neon/Project";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const expectPooledOrigin = (project: {
  pooledConnectionUri: string;
  pooledOrigin: PostgresOrigin;
}) => {
  const uri = new URL(project.pooledConnectionUri);
  expect(project.pooledOrigin).toMatchObject({
    scheme: uri.protocol === "postgresql:" ? "postgresql" : "postgres",
    host: uri.hostname,
    port: uri.port ? Number(uri.port) : 5432,
    database: uri.pathname.replace(/^\//, ""),
    user: decodeURIComponent(uri.username),
  });
  expect(project.pooledOrigin.password).toBeDefined();
};

test.provider(
  "create and delete project with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Project("DefaultProject");
        }),
      );

      expect(project.projectId).toBeDefined();
      expect(project.projectName).toBeDefined();
      expect(project.defaultBranchId).toBeDefined();
      expect(project.connectionUri).toContain("postgres");
      expect(project.pooledConnectionUri).toContain("postgres");
      expectPooledOrigin(project);

      const fetched = yield* getProject({ project_id: project.projectId });
      expect(fetched.project.id).toEqual(project.projectId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:neon", "provider:neon:project", "live"] },
);

test.provider(
  "project with default props does not change on update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = stack.deploy(Project("DefaultProjectUpdate"));

      const created = yield* deploy;

      expect(created.projectId).toBeDefined();
      expect(created.projectName).toBeDefined();
      expect(created.defaultBranchId).toBeDefined();
      expect(created.connectionUri).toContain("postgres");
      expectPooledOrigin(created);

      const fetched = yield* getProject({ project_id: created.projectId });
      expect(fetched.project.id).toEqual(created.projectId);

      const updated = yield* deploy;

      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.projectName).toEqual(created.projectName);
      expect(updated.defaultBranchId).toEqual(created.defaultBranchId);
      expect(updated.connectionUri).toEqual(created.connectionUri);
      expectPooledOrigin(updated);

      const renamed = yield* stack.deploy(
        Project("DefaultProjectUpdate", {
          name: `${created.projectName}-renamed`,
        }),
      );
      expect(renamed.projectId).toBe(created.projectId);
      expect(
        (yield* getProject({ project_id: renamed.projectId })).project.name,
      ).toBe(`${created.projectName}-renamed`);
      const preserved = yield* deploy;
      expect(preserved.projectId).toBe(created.projectId);
      expect(preserved.projectName).toBe(renamed.projectName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:neon", "provider:neon:project", "live"] },
);

test.provider(
  "enable logical replication on update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Project("LogicalReplicationProject", {
            region: "aws-us-east-1",
          });
        }),
      );
      expect(initial.enableLogicalReplication).toEqual(false);

      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Project("LogicalReplicationProject", {
            region: "aws-us-east-1",
            enableLogicalReplication: true,
          });
        }),
      );
      expect(enabled.projectId).toEqual(initial.projectId);
      expect(enabled.enableLogicalReplication).toEqual(true);

      const fetched = yield* getProject({ project_id: enabled.projectId });
      expect(fetched.project.settings).toMatchObject({
        enable_logical_replication: true,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:neon", "provider:neon:project", "live"] },
);

test.provider(
  "observes project drift, removal, adoption, and missing cached identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (historyRetentionSeconds?: number) =>
        stack.deploy(
          Project("ObservedProject", {
            defaultBranchName: "production",
            historyRetentionSeconds,
          }),
        );
      const initial = yield* deploy(21600);
      expect(initial.defaultBranchName).toBe("production");
      const provider = yield* Provider.findProvider(Project);
      const context = {
        id: "ObservedProject",
        fqn: "ObservedProject",
        instanceId: "observed-project",
        bindings: [],
        session: {
          emit: () => Effect.void,
          done: () => Effect.void,
          note: () => Effect.void,
        },
      };
      const news = {
        name: initial.projectName,
        defaultBranchName: "production",
        historyRetentionSeconds: 21600,
      };
      const unowned = yield* provider.read!({
        ...context,
        olds: news,
        output: undefined,
      });
      expect(Unowned.is(unowned)).toBe(true);
      const drift = yield* updateProject({
        project_id: initial.projectId,
        project: { history_retention_seconds: 0 },
      });
      yield* waitForOperations(drift.operations);
      const adopted = yield* provider.reconcile({
        ...context,
        news,
        olds: undefined,
        output: initial,
      });
      expect(adopted.historyRetentionSeconds).toBe(21600);
      const reset = yield* deploy();
      expect(
        (yield* getProject({ project_id: reset.projectId })).project
          .history_retention_seconds,
      ).toBe(86400);
      const uri = yield* getConnectionURI({
        project_id: reset.projectId,
        branch_id: reset.defaultBranchId,
        database_name: reset.databaseName,
        role_name: reset.roleName,
        pooled: true,
      });
      expect(reset.pooledConnectionUri === uri.uri).toBe(true);
      yield* deleteProject({ project_id: reset.projectId });
      const recovered = yield* deploy(21600);
      expect(recovered.projectId).not.toBe(reset.projectId);
      const persisted = yield* deploy(21600);
      expect(persisted.projectId).toBe(recovered.projectId);
      yield* stack.destroy();
      yield* stack.destroy();
      expect(
        yield* getProject({ project_id: recovered.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: ["provider:neon", "provider:neon:project", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "explicit project names use delete-first immutable replacements",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (props: ProjectProps = {}) =>
        Project("NamedProject", {
          name: "alchemy-neon-named-replacement",
          ...props,
        });
      const initial = yield* stack.deploy(program());
      for (const props of [
        { region: "aws-us-west-2" },
        { pgVersion: 16 },
        { defaultBranchName: "production" },
        { databaseName: "application" },
        { roleName: "application_owner" },
      ] satisfies ProjectProps[]) {
        const plan = yield* stack.plan(program(props));
        expect(plan.resources.NamedProject).toMatchObject({
          action: "replace",
          deleteFirst: true,
        });
      }
      const renamed = yield* stack.plan(
        program({
          name: "alchemy-neon-renamed-replacement",
          databaseName: "application",
        }),
      );
      expect(renamed.resources.NamedProject).toMatchObject({
        action: "replace",
        deleteFirst: false,
      });
      const provider = yield* Provider.findProvider(Project);
      const recovery = yield* provider
        .reconcile({
          id: "NamedProject",
          fqn: "NamedProject",
          instanceId: "replacement-project",
          news: { name: initial.projectName, databaseName: "application" },
          olds: undefined,
          output: undefined,
          bindings: [],
          session: {
            emit: () => Effect.void,
            done: () => Effect.void,
            note: () => Effect.void,
          },
        })
        .pipe(Effect.result);
      expect(Result.isFailure(recovery)).toBe(true);
      if (Result.isFailure(recovery))
        expect(recovery.failure).toBeInstanceOf(OwnedBySomeoneElse);
      const replaced = yield* stack.deploy(
        program({ databaseName: "application" }),
      );
      expect(replaced.projectId).not.toBe(initial.projectId);
      expect(replaced.projectName).toBe(initial.projectName);
      expect(replaced.databaseName).toBe("application");
      expect(
        (yield* getProject({ project_id: replaced.projectId })).project.id,
      ).toBe(replaced.projectId);
      expect(
        yield* getProject({ project_id: initial.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      const stable = yield* stack.deploy(
        program({ databaseName: "application" }),
      );
      expect(stable.projectId).toBe(replaced.projectId);
      yield* stack.destroy();
      expect(
        yield* getProject({ project_id: replaced.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: ["provider:neon", "provider:neon:project", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "refuses late same-name projects and foreign replacements of cached identities",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const owners = Effect.gen(function* () {
        const cached = yield* Project("CachedProject");
        const foreign = yield* Project("ForeignProject");
        return { cached, foreign };
      });
      const initial = yield* stack.deploy(owners);
      const name = "alchemy-neon-late-project";
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          yield* owners;
          return yield* Project("LateProject", { name });
        }),
      );
      expect(plan.resources.LateProject.action).toBe("create");
      const renamed = yield* updateProject({
        project_id: initial.foreign.projectId,
        project: { name, history_retention_seconds: 21600 },
      });
      yield* waitForOperations(renamed.operations);
      const provider = yield* Provider.findProvider(Project);
      const context = {
        id: "LateProject",
        fqn: "LateProject",
        instanceId: "late-project",
        bindings: [],
        session: {
          emit: () => Effect.void,
          done: () => Effect.void,
          note: () => Effect.void,
        },
      };
      const late = yield* provider
        .reconcile({
          ...context,
          news: { name },
          olds: undefined,
          output: undefined,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(late)).toBe(true);
      if (Result.isFailure(late))
        expect(late.failure).toBeInstanceOf(OwnedBySomeoneElse);
      yield* deleteProject({ project_id: initial.cached.projectId });
      const cached = yield* provider
        .reconcile({
          ...context,
          news: { name },
          olds: {},
          output: initial.cached,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(cached)).toBe(true);
      if (Result.isFailure(cached))
        expect(cached.failure).toBeInstanceOf(OwnedBySomeoneElse);
      const observed = yield* getProject({
        project_id: initial.foreign.projectId,
      });
      expect(observed.project.history_retention_seconds).toBe(21600);
      expect(observed.project.name).toBe(name);
      yield* stack.destroy();
      for (const project of [initial.cached, initial.foreign]) {
        expect(
          yield* getProject({ project_id: project.projectId }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
      }
    }),
  {
    tags: ["provider:neon", "provider:neon:project", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "explicit adoption preserves customized project database and role defaults",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = "alchemy-neon-custom-adoption";
      const foreign = yield* createProject({
        project: {
          name,
          region_id: "aws-us-east-1",
          pg_version: 17,
          branch: {
            name: "production",
            database_name: "application",
            role_name: "application_owner",
          },
        },
      });
      yield* waitForOperations(foreign.operations);
      const program = (allow: boolean) =>
        Project("CustomizedProject", { name }).pipe(adopt(allow));
      const refused = yield* stack.plan(program(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused))
        expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);
      const plan = yield* stack.plan(program(true));
      expect(plan.resources.CustomizedProject.action).not.toBe("replace");
      const adopted = yield* stack.deploy(program(true));
      expect(adopted.projectId).toBe(foreign.project.id);
      expect(adopted.defaultBranchName).toBe("production");
      expect(adopted.databaseName).toBe("application");
      expect(adopted.roleName).toBe("application_owner");
      const stable = yield* stack.plan(program(false));
      expect(stable.resources.CustomizedProject.action).toBe("noop");
      expect((yield* stack.deploy(program(false))).projectId).toBe(
        foreign.project.id,
      );
      expect(
        (yield* getProject({ project_id: foreign.project.id })).project.id,
      ).toBe(foreign.project.id);
      yield* stack.destroy();
      expect(
        yield* getProject({ project_id: foreign.project.id }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: ["provider:neon", "provider:neon:project", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "list enumerates the deployed project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Project("ListProject");
        }),
      );

      const provider = yield* Provider.findProvider(Project);
      const all = yield* provider.list();

      const found = all.find((p) => p.projectId === deployed.projectId);
      expect(found).toBeDefined();
      expectPooledOrigin(found!);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:neon", "provider:neon:project", "live"] },
);

/**
 * Adopting a drizzle-kit-migrated Postgres database: drizzle's table lives
 * schema-qualified at `drizzle.__drizzle_migrations` on pg. The first
 * deploy with migrations converts that history into the public
 * `__alchemy_migrations` (hashes carried verbatim) and freezes drizzle's
 * table. This is the only place the schema-qualified source read and the
 * pg-dialect conversion DDL execute against a real Postgres.
 */
test.provider(
  "adopts a drizzle-kit-migrated Postgres database via one-way conversion",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-neon-drizzle-",
      });
      const initSql =
        "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);";
      yield* fs.makeDirectory(path.join(migrationsDir, "20240101000000_init"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101000000_init", "migration.sql"),
        initSql,
      );
      const initHash = yield* hashMigrations(migrationsDir).pipe(
        Effect.map((hashes) => Object.values(hashes)[0]),
      );

      yield* stack.destroy();

      // Phase 1: what `drizzle-kit migrate` left behind on Postgres.
      const seeded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Project("DrizzleAdoptionProject");
        }),
      );
      const connectionUri = Redacted.make(seeded.connectionUri);
      yield* runSql(connectionUri, initSql);
      yield* runSql(connectionUri, "CREATE SCHEMA IF NOT EXISTS drizzle;");
      yield* runSql(
        connectionUri,
        `CREATE TABLE drizzle.__drizzle_migrations (
           id SERIAL PRIMARY KEY,
           hash text NOT NULL,
           created_at bigint,
           name text,
           applied_at timestamp with time zone DEFAULT now()
         );`,
      );
      yield* runSql(
        connectionUri,
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name)
         VALUES ('${initHash}', 1704067200000, '20240101000000_init');`,
      );

      // Phase 2: first deploy with migrations + a pending one.
      yield* fs.makeDirectory(path.join(migrationsDir, "20240102000000_posts"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240102000000_posts", "migration.sql"),
        "CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL);",
      );
      const project = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Project("DrizzleAdoptionProject", {
            migrations: migrationsDir,
          });
        }),
      );
      expect(project.projectId).toEqual(seeded.projectId);
      expect(project.migrationsTable).toEqual("__alchemy_migrations");

      // History converted (hash verbatim), only the pending migration ran
      // (a replay of init's bare CREATE TABLE would fail).
      const applied = yield* withPgClient(connectionUri, (client) =>
        makePgMigrationExecutor(client).query(
          "SELECT name, hash FROM __alchemy_migrations ORDER BY id;",
        ),
      );
      expect(applied.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_posts",
      ]);
      expect(applied[0].hash).toBe(initHash);

      // drizzle's schema-qualified table is frozen.
      const frozen = yield* withPgClient(connectionUri, (client) =>
        makePgMigrationExecutor(client).query(
          "SELECT name FROM drizzle.__drizzle_migrations ORDER BY id;",
        ),
      );
      expect(frozen.map((r) => r.name)).toEqual(["20240101000000_init"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:neon", "provider:neon:project", "live"] },
);

test.provider(
  "create project, apply migrations and seed data, then create a branch",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-neon-migrations-",
      });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);",
      );
      const seedDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-neon-seed-",
      });
      const seedPath = path.join(seedDir, "seed.sql");
      yield* fs.writeFileString(
        seedPath,
        "INSERT INTO users (name) VALUES ('alice'), ('bob');",
      );

      yield* stack.destroy();

      const { project, branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("MigrationProject", {
            migrations: migrationsDir,
            importFiles: [seedPath],
          });
          const branch = yield* Branch("FeatureBranch", {
            project,
          });
          return { project, branch };
        }),
      );

      // Fresh deploys use Alchemy's one table; legacy rows that persisted
      // neon_migrations keep converging against it via state.
      expect(project.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(project.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
      ]);
      expect(project.importHashes[seedPath]).toBeDefined();

      expect(branch.projectId).toEqual(project.projectId);
      expect(branch.parentBranchId).toEqual(project.defaultBranchId);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
  },
);
