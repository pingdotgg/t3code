import * as Neon from "@/Neon";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { getProject } from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Neon.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const expectPooledOrigin = (project: {
  pooledConnectionUri: string;
  pooledOrigin: Neon.PostgresOrigin;
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

test.provider("create and delete project with default props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const project = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Neon.Project("DefaultProject");
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
);

test.provider("project with default props does not change on update", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(Neon.Project("DefaultProjectUpdate"));

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

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("enable logical replication on update", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Neon.Project("LogicalReplicationProject", {
          name: "alchemy-test-logical-replication",
          region: "aws-us-east-1",
        });
      }),
    );
    expect(initial.enableLogicalReplication).toEqual(false);

    const enabled = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Neon.Project("LogicalReplicationProject", {
          name: "alchemy-test-logical-replication",
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
);

test.provider("list enumerates the deployed project", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Neon.Project("ListProject");
      }),
    );

    const provider = yield* Provider.findProvider(Neon.Project);
    const all = yield* provider.list();

    const found = all.find((p) => p.projectId === deployed.projectId);
    expect(found).toBeDefined();
    expectPooledOrigin(found!);

    yield* stack.destroy();
  }).pipe(logLevel),
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
          const project = yield* Neon.Project("MigrationProject", {
            migrationsDir,
            importFiles: [seedPath],
          });
          const branch = yield* Neon.Branch("FeatureBranch", {
            project,
          });
          return { project, branch };
        }),
      );

      expect(project.migrationsTable).toEqual("neon_migrations");
      expect(Object.keys(project.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
      ]);
      expect(project.importHashes[seedPath]).toBeDefined();

      expect(branch.projectId).toEqual(project.projectId);
      expect(branch.parentBranchId).toEqual(project.defaultBranchId);

      yield* stack.destroy();
    }).pipe(logLevel),
);
