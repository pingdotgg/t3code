import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import {
  getBranch,
  getDatabase,
  getProject,
  getProjectBranches,
  updateDatabase,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Prisma.providers() });

const expectDatabase = Effect.fn(function* (
  database: Prisma.Database["Attributes"],
  branchId: string,
) {
  const observed = yield* getDatabase({ databaseId: database.databaseId });
  expect(observed.data.id).toBe(database.databaseId);
  expect(observed.data.project.id).toBe(database.projectId);
  expect(observed.data.name).toBe(database.databaseName);
  expect(observed.data.branchId).toBe(branchId);
  expect(database.branchId).toBe(branchId);
});

const expectGone = <E, R>(read: Effect.Effect<boolean, E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (gone) => gone,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const expectDatabaseGone = (databaseId: string) =>
  expectGone(
    getDatabase({ databaseId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const expectBranchGone = (branchId: string) =>
  expectGone(
    getBranch({ branchId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const expectProjectGone = (id: string) =>
  expectGone(
    getProject({ id }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

test.provider(
  "attaches named and generated databases to the default branch and preserves it on updates",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (updated = false) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {
          createDatabase: false,
        });
        const generated = yield* Prisma.Database("Generated", {
          project,
          name: updated ? "generated-updated" : undefined,
        });
        const named = yield* Prisma.Database("Named", {
          project,
          name: updated ? "named-updated" : "named-database",
        });
        return { project, generated, named };
      });

    const initial = yield* stack.deploy(resources());
    const branches = yield* getProjectBranches({
      projectId: initial.project.projectId,
    });
    const defaults = branches.data.filter((branch) => branch.isDefault);
    expect(defaults).toHaveLength(1);
    const defaultBranch = defaults[0]!;
    yield* expectDatabase(initial.generated, defaultBranch.id);
    yield* expectDatabase(initial.named, defaultBranch.id);

    const updated = yield* stack.deploy(resources(true));
    expect(updated.generated.databaseId).toBe(initial.generated.databaseId);
    expect(updated.named.databaseId).toBe(initial.named.databaseId);
    expect(updated.generated.databaseName).toBe("generated-updated");
    expect(updated.named.databaseName).toBe("named-updated");
    yield* expectDatabase(updated.generated, defaultBranch.id);
    yield* expectDatabase(updated.named, defaultBranch.id);

    const repeated = yield* stack.deploy(resources(true));
    expect(repeated.generated.databaseId).toBe(initial.generated.databaseId);
    expect(repeated.named.databaseId).toBe(initial.named.databaseId);
    yield* expectDatabase(repeated.generated, defaultBranch.id);
    yield* expectDatabase(repeated.named, defaultBranch.id);

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.generated.databaseId);
    yield* expectDatabaseGone(initial.named.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:database",
      "provider:prisma:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "preserves a non-default branch when explicit branch props are removed or the attachment changes out of band",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (
      attachment: "id" | "gitName" | "omitted",
      name?: string,
    ) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {
          createDatabase: false,
        });
        const first = yield* Prisma.Branch("First", {
          project,
          gitName: "feature/first",
        });
        const second = yield* Prisma.Branch("Second", {
          project,
          gitName: "feature/second",
        });
        const database = yield* Prisma.Database("Database", {
          project,
          name,
          ...(attachment === "id"
            ? { branchId: first.branchId }
            : attachment === "gitName"
              ? { branchGitName: second.gitName }
              : {}),
        });
        return { project, first, second, database };
      });

    const initial = yield* stack.deploy(resources("id"));
    expect(initial.first.isDefault).toBe(false);
    expect(initial.second.isDefault).toBe(false);
    yield* expectDatabase(initial.database, initial.first.branchId);

    const byName = yield* stack.deploy(resources("gitName"));
    expect(byName.database.databaseId).toBe(initial.database.databaseId);
    yield* expectDatabase(byName.database, initial.second.branchId);

    const omitted = yield* stack.deploy(resources("omitted", "renamed"));
    expect(omitted.database.databaseId).toBe(initial.database.databaseId);
    expect(omitted.database.databaseName).toBe("renamed");
    yield* expectDatabase(omitted.database, initial.second.branchId);

    yield* updateDatabase({
      databaseId: initial.database.databaseId,
      branchId: initial.first.branchId,
    });
    const drifted = yield* stack.deploy(resources("omitted", "renamed-again"));
    expect(drifted.database.databaseId).toBe(initial.database.databaseId);
    expect(drifted.database.databaseName).toBe("renamed-again");
    yield* expectDatabase(drifted.database, initial.first.branchId);

    const explicit = yield* stack.deploy(resources("gitName", "renamed-again"));
    expect(explicit.database.databaseId).toBe(initial.database.databaseId);
    yield* expectDatabase(explicit.database, initial.second.branchId);

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectBranchGone(initial.first.branchId);
    yield* expectBranchGone(initial.second.branchId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:branch",
      "provider:prisma:database",
      "provider:prisma:project",
      "live",
    ],
    timeout: 120_000,
  },
);
