import * as Prisma from "@alchemy.run/prisma";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getService, updateService } from "@distilled.cloud/prisma/management";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  expectGone,
  expectProjectGone,
  failureOf,
  forgetState,
  markCreating,
  patchStateAttr,
} from "./fixtures/Live.ts";

const live = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:app",
  "provider:prisma:branch",
  "provider:prisma:project",
  "live",
];

const observeApp = (appId: string) =>
  getService({ serviceId: appId }).pipe(Effect.map((response) => response.data));

const expectAppGone = (appId: string) =>
  expectGone(
    getService({ serviceId: appId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const appStack = (props: { displayName?: string; logicalId?: string } = {}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const app = yield* Prisma.App("Web", { project, ...props });
    return { project, app };
  });

live.test.provider(
  "creates an App under its fqn logical ID and converges name and logical ID in place",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(appStack());
    expect(initial.app.logicalId).toBe("Web");
    const created = yield* observeApp(initial.app.appId);
    expect(created.projectId).toBe(initial.project.projectId);
    expect(created.name).toBe(initial.app.name);
    expect(created.logicalId).toBe("Web");

    const renamed = yield* stack.deploy(appStack({ displayName: "renamed-web" }));
    expect(renamed.app.appId).toBe(initial.app.appId);
    expect((yield* observeApp(initial.app.appId)).name).toBe("renamed-web");

    const overridden = yield* stack.deploy(
      appStack({ displayName: "renamed-web", logicalId: "web-override" }),
    );
    expect(overridden.app.appId).toBe(initial.app.appId);
    expect(overridden.app.logicalId).toBe("web-override");
    expect((yield* observeApp(initial.app.appId)).logicalId).toBe("web-override");

    // Removing the override returns to the fqn.
    const reverted = yield* stack.deploy(appStack({ displayName: "renamed-web" }));
    expect(reverted.app.appId).toBe(initial.app.appId);
    expect((yield* observeApp(initial.app.appId)).logicalId).toBe("Web");

    const repeated = yield* stack.deploy(appStack({ displayName: "renamed-web" }));
    expect(repeated.app.appId).toBe(initial.app.appId);

    // Nuke enumerates Apps through the provider's list.
    const listed = yield* (yield* Provider.findProvider(Prisma.App)).list!();
    expect(listed.map((app) => app.appId)).toContain(initial.app.appId);

    yield* stack.destroy();
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "after lost state, adoption finds the App by its logical ID despite a Console rename",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(appStack());
    yield* updateService({ serviceId: initial.app.appId, displayName: "renamed-in-console" });
    // Lost state also loses the instance ID, so nothing proves the App is ours.
    yield* forgetState(stack, "Web");

    const refused = yield* failureOf(stack.deploy(appStack()));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    expect((yield* observeApp(initial.app.appId)).name).toBe("renamed-in-console");

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.App("Web", { project }).pipe(adopt(true));
        return { project, app };
      }),
    );
    expect(adopted.app.appId).toBe(initial.app.appId);
    const observed = yield* observeApp(initial.app.appId);
    expect(observed.name).toBe(adopted.app.name);
    expect(observed.logicalId).toBe("Web");

    yield* stack.destroy();
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "recovers an interrupted App create as owned",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(appStack());
    // The App exists, but the create never committed its attributes.
    yield* markCreating(stack, "Web");

    const recovered = yield* stack.deploy(appStack());
    expect(recovered.app.appId).toBe(initial.app.appId);
    expect((yield* observeApp(initial.app.appId)).logicalId).toBe("Web");

    yield* stack.destroy();
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "a later declaration reusing a held logical ID does not take over the App",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (withSecond: boolean) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const first = yield* Prisma.App("First", { project, logicalId: "shared" });
        const second = withSecond
          ? yield* Prisma.App("Second", { project, logicalId: "shared" })
          : undefined;
        return { project, first, second };
      });

    const initial = yield* stack.deploy(resources(false));
    const refused = yield* failureOf(stack.deploy(resources(true)));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    // First's App survives a deploy that drops the failed declaration.
    yield* stack.deploy(resources(false));
    expect((yield* observeApp(initial.first.appId)).logicalId).toBe("shared");

    yield* stack.destroy();
    yield* expectAppGone(initial.first.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "sets the logical ID on an App deployed before logical IDs existed",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(appStack({ displayName: "legacy-web" }));
    // What an earlier provider version left behind: no logical ID in the
    // cloud or in the persisted attributes.
    yield* updateService({ serviceId: initial.app.appId, logicalId: null });
    yield* patchStateAttr(stack, "Web", { logicalId: null });
    expect((yield* observeApp(initial.app.appId)).logicalId).toBeNull();

    const stamped = yield* stack.deploy(appStack({ displayName: "legacy-web" }));
    expect(stamped.app.appId).toBe(initial.app.appId);
    expect(stamped.app.logicalId).toBe("Web");
    expect((yield* observeApp(initial.app.appId)).logicalId).toBe("Web");

    yield* stack.destroy();
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "requires adoption for an App without a logical ID after lost state, then sets it",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(appStack({ displayName: "legacy-web" }));
    yield* updateService({ serviceId: initial.app.appId, logicalId: null });
    yield* forgetState(stack, "Web");

    // Found only by display name, so it is not provably ours.
    const refused = yield* failureOf(stack.deploy(appStack({ displayName: "legacy-web" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.App("Web", { project, displayName: "legacy-web" }).pipe(
          adopt(true),
        );
        return { project, app };
      }),
    );
    expect(adopted.app.appId).toBe(initial.app.appId);
    expect((yield* observeApp(initial.app.appId)).logicalId).toBe("Web");

    yield* stack.destroy();
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "rejects a logical ID that another App on the branch holds",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (secondLogicalId: string) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const first = yield* Prisma.App("First", { project, logicalId: "shared" });
        const second = yield* Prisma.App("Second", { project, logicalId: secondLogicalId });
        return { project, first, second };
      });

    const initial = yield* stack.deploy(resources("second"));
    expect(initial.second.appId).not.toBe(initial.first.appId);

    const failure = yield* failureOf(stack.deploy(resources("shared")));
    expect(failure.text).toContain("logical ID 'shared'");
    expect((yield* observeApp(initial.first.appId)).logicalId).toBe("shared");

    yield* stack.destroy();
    yield* expectAppGone(initial.first.appId);
    yield* expectAppGone(initial.second.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "attaches to a branch by git name and inherits the project region",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {
          createDatabase: false,
          region: "eu-west-3",
        });
        const branch = yield* Prisma.Branch("Feature", { project, gitName: "feature/app" });
        const app = yield* Prisma.App("Web", { project, branchGitName: branch.gitName });
        return { project, branch, app };
      }),
    );
    expect(deployed.app.branchId).toBe(deployed.branch.branchId);
    expect(deployed.app.regionId).toBe("eu-west-3");
    const observed = yield* observeApp(deployed.app.appId);
    expect(observed.branchId).toBe(deployed.branch.branchId);
    expect(observed.region.id).toBe("eu-west-3");

    yield* stack.destroy();
    yield* expectAppGone(deployed.app.appId);
    yield* expectProjectGone(deployed.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "refuses a region change and replaces the App when its project changes",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    // Both projects exist before the move, so the new project ID is known at plan time.
    const resources = (target: "first" | "second", regionId?: "us-east-1" | "eu-west-3") =>
      Effect.gen(function* () {
        const first = yield* Prisma.Project("First", { createDatabase: false });
        const second = yield* Prisma.Project("Second", { createDatabase: false });
        const app = yield* Prisma.App("Web", {
          project: target === "first" ? first : second,
          ...(regionId === undefined ? {} : { regionId }),
        });
        return { first, second, app };
      });

    const initial = yield* stack.deploy(resources("first"));
    expect(initial.app.regionId).toBe("us-east-1");

    const moved = yield* failureOf(stack.deploy(resources("first", "eu-west-3")));
    expect(moved.text).toContain("cannot atomically move an App");
    expect((yield* observeApp(initial.app.appId)).region.id).toBe("us-east-1");

    const replaced = yield* stack.deploy(resources("second"));
    expect(replaced.app.appId).not.toBe(initial.app.appId);
    expect((yield* observeApp(replaced.app.appId)).projectId).toBe(initial.second.projectId);
    yield* expectAppGone(initial.app.appId);

    yield* stack.destroy();
    yield* expectAppGone(replaced.app.appId);
    yield* expectProjectGone(initial.first.projectId);
    yield* expectProjectGone(initial.second.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "follows a newly promoted default branch",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (promote: boolean) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const next = promote
          ? yield* Prisma.Branch("Next", { project, gitName: "next", isDefault: true })
          : undefined;
        const app = yield* Prisma.App("Web", { project });
        return { project, next, app };
      });

    const initial = yield* stack.deploy(resources(false));
    // The promotion lands first; the next deploy sees the new default.
    yield* stack.deploy(resources(true));
    const followed = yield* stack.deploy(resources(true));
    expect(followed.app.appId).toBe(initial.app.appId);
    expect(followed.app.branchId).toBe(followed.next!.branchId);
    expect((yield* observeApp(initial.app.appId)).branchId).toBe(followed.next!.branchId);

    yield* stack.destroy();
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "repairs out-of-band drift on the next update and deletes despite it",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (logicalId?: string) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const feature = yield* Prisma.Branch("Feature", { project, gitName: "feature/drift" });
        const app = yield* Prisma.App("Web", {
          project,
          displayName: "web",
          ...(logicalId === undefined ? {} : { logicalId }),
        });
        return { project, feature, app };
      });

    const initial = yield* stack.deploy(resources());
    const defaultBranchId = initial.app.branchId;
    yield* updateService({
      serviceId: initial.app.appId,
      displayName: "drifted",
      branchId: initial.feature.branchId,
    });

    // Any update reconciles against observed state, not the persisted attributes.
    const repaired = yield* stack.deploy(resources("web-repaired"));
    expect(repaired.app.appId).toBe(initial.app.appId);
    const observed = yield* observeApp(initial.app.appId);
    expect(observed.name).toBe("web");
    expect(observed.branchId).toBe(defaultBranchId);
    expect(observed.logicalId).toBe("web-repaired");

    yield* updateService({ serviceId: initial.app.appId, displayName: "drifted-again" });
    yield* stack.destroy();
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);
