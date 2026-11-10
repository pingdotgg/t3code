import * as Prisma from "@alchemy.run/prisma";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getBranch,
  getDatabase,
  getProject,
  getProjectBranches,
  updateDatabase,
} from "@distilled.cloud/prisma/management";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { failureOf, forgetState, markCreating, patchStateAttr } from "./fixtures/Live.ts";

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
    tags: ["provider:prisma", "provider:prisma:database", "provider:prisma:project", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "preserves a non-default branch when explicit branch props are removed or the attachment changes out of band",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (attachment: "id" | "gitName" | "omitted", name?: string) =>
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

const logicalIdTags = [
  "provider:prisma",
  "provider:prisma:database",
  "provider:prisma:project",
  "live",
];

const observeDatabase = (databaseId: string) =>
  getDatabase({ databaseId }).pipe(Effect.map((response) => response.data));

const databaseStack = (props: { name?: string; logicalId?: string } = {}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const database = yield* Prisma.Database("Main", { project, ...props });
    return { project, database };
  });

test.provider(
  "an explicitly named database moves region by replacing itself delete-first",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const regional = (region: "us-east-1" | "eu-central-1") =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const database = yield* Prisma.Database("Regional", {
          project,
          name: "regional",
          region,
        });
        return { project, database };
      });

    const initial = yield* stack.deploy(regional("us-east-1"));
    expect((yield* observeDatabase(initial.database.databaseId)).region?.id).toBe("us-east-1");

    // The replacement reuses the explicit name, so the old database goes first.
    const moved = yield* stack.deploy(regional("eu-central-1"));
    expect(moved.database.databaseId).not.toBe(initial.database.databaseId);
    expect(moved.database.databaseName).toBe("regional");
    expect((yield* observeDatabase(moved.database.databaseId)).region?.id).toBe("eu-central-1");
    yield* expectDatabaseGone(initial.database.databaseId);

    yield* stack.destroy();
    yield* expectDatabaseGone(moved.database.databaseId);
    yield* expectProjectGone(moved.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "creates a database under its fqn logical ID and rebinds the logical ID in place",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack());
    expect(initial.database.logicalId).toBe("Main");
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    const overridden = yield* stack.deploy(databaseStack({ logicalId: "main-db" }));
    expect(overridden.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("main-db");

    const reverted = yield* stack.deploy(databaseStack());
    expect(reverted.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "after lost state, adoption finds the database by its logical ID despite a Console rename",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack({ name: "main-db" }));
    yield* updateDatabase({ databaseId: initial.database.databaseId, name: "renamed-in-console" });
    yield* forgetState(stack, "Main");

    const refused = yield* failureOf(stack.deploy(databaseStack({ name: "main-db" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const database = yield* Prisma.Database("Main", { project, name: "main-db" }).pipe(
          adopt(true),
        );
        return { project, database };
      }),
    );
    expect(adopted.database.databaseId).toBe(initial.database.databaseId);
    const observed = yield* observeDatabase(initial.database.databaseId);
    expect(observed.name).toBe("main-db");
    expect(observed.logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "recovers an interrupted database create as owned",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack());
    yield* markCreating(stack, "Main");

    const recovered = yield* stack.deploy(databaseStack());
    expect(recovered.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "sets the logical ID on a database deployed before logical IDs existed",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(databaseStack());
    yield* updateDatabase({ databaseId: initial.database.databaseId, logicalId: null });
    yield* patchStateAttr(stack, "Main", { logicalId: null });
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBeNull();

    const stamped = yield* stack.deploy(databaseStack());
    expect(stamped.database.databaseId).toBe(initial.database.databaseId);
    expect((yield* observeDatabase(initial.database.databaseId)).logicalId).toBe("Main");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "creates a database on a git branch that does not exist yet, then sets its logical ID",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", { createDatabase: false });
      const database = yield* Prisma.Database("Preview", {
        project,
        branchGitName: "feature/preview",
      });
      return { project, database };
    });

    const initial = yield* stack.deploy(resources);
    const branches = yield* getProjectBranches({
      projectId: initial.project.projectId,
      gitName: "feature/preview",
    });
    expect(branches.data).toHaveLength(1);
    const observed = yield* observeDatabase(initial.database.databaseId);
    expect(observed.branchId).toBe(branches.data[0]!.id);
    expect(observed.logicalId).toBe("Preview");

    const repeated = yield* stack.deploy(resources);
    expect(repeated.database.databaseId).toBe(initial.database.databaseId);

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "rejects a logical ID that another database on the branch holds",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (secondLogicalId: string) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const first = yield* Prisma.Database("First", { project, logicalId: "shared" });
        const second = yield* Prisma.Database("Second", { project, logicalId: secondLogicalId });
        return { project, first, second };
      });

    const initial = yield* stack.deploy(resources("second"));
    const failure = yield* failureOf(stack.deploy(resources("shared")));
    expect(failure.text).toContain("logical ID 'shared'");
    expect((yield* observeDatabase(initial.first.databaseId)).logicalId).toBe("shared");

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.first.databaseId);
    yield* expectDatabaseGone(initial.second.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "region inherit uses the project default region when the project has no default database",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", {
        createDatabase: false,
        region: "eu-central-1",
      });
      const database = yield* Prisma.Database("Inherited", { project, region: "inherit" });
      return { project, database };
    });

    const initial = yield* stack.deploy(resources);
    expect((yield* getProject({ id: initial.project.projectId })).data.defaultRegion).toBe(
      "eu-central-1",
    );
    expect(initial.database.region).toBe("eu-central-1");
    expect((yield* observeDatabase(initial.database.databaseId)).region?.id).toBe("eu-central-1");

    const repeated = yield* stack.deploy(resources);
    expect(repeated.database.databaseId).toBe(initial.database.databaseId);

    yield* stack.destroy();
    yield* expectDatabaseGone(initial.database.databaseId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);

test.provider(
  "region inherit fails before creating anything when the project has no region",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const failure = yield* failureOf(
      stack.deploy(
        Effect.gen(function* () {
          const project = yield* Prisma.Project("Project", { createDatabase: false });
          const database = yield* Prisma.Database("Inherited", { project, region: "inherit" });
          return { project, database };
        }),
      ),
    );
    expect(failure.text).toContain("has no default region and no default database region");

    yield* stack.destroy();
  }),
  { tags: logicalIdTags, timeout: 180_000 },
);
