import * as Neon from "@/Neon";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { deleteProjectBranch, getProjectBranch } from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Neon.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const expectPooledOrigin = (branch: {
  pooledConnectionUri: string;
  pooledOrigin: Neon.PostgresOrigin;
}) => {
  const uri = new URL(branch.pooledConnectionUri);
  expect(branch.pooledOrigin).toMatchObject({
    scheme: uri.protocol === "postgresql:" ? "postgresql" : "postgres",
    host: uri.hostname,
    port: uri.port ? Number(uri.port) : 5432,
    database: uri.pathname.replace(/^\//, ""),
    user: decodeURIComponent(uri.username),
  });
  expect(branch.pooledOrigin.password).toBeDefined();
};

// Canonical `list()` test (parent fan-out): branches are scoped to a project
// and there is no account-wide branch enumeration API, so `list()` enumerates
// every project and lists+hydrates the branches of each. Deploy a project +
// branch, then assert the deployed branch appears in the exhaustive result.
test.provider("list enumerates the deployed branch", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { project, branch } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ListBranchProject");
        const branch = yield* Neon.Branch("ListBranch", { project });
        return { project, branch };
      }),
    );

    const provider = yield* Provider.findProvider(Neon.Branch);
    const all = yield* provider.list();

    const found = all.find((b) => b.branchId === branch.branchId);
    expect(found).toBeDefined();
    expect(found?.projectId).toEqual(project.projectId);
    expect(found?.branchName).toEqual(branch.branchName);
    expect(found?.connectionUri).toContain("postgres");
    expectPooledOrigin(branch);
    expectPooledOrigin(found!);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "updating project in-place does not replace the branch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("UpdateBranchProject", {
            enableLogicalReplication: false,
          });
          const branch = yield* Neon.Branch("UpdateBranch", {
            project,
          });
          return { project, branch };
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("UpdateBranchProject", {
            enableLogicalReplication: true,
          });
          const branch = yield* Neon.Branch("UpdateBranch", {
            project,
          });
          return { project, branch };
        }),
      );

      expect(updated.branch.projectId).toEqual(updated.project.projectId);
      expect(updated.branch.branchId).toEqual(initial.branch.branchId);
      expectPooledOrigin(updated.branch);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "replaces branch when project changes to another pre-existing project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const projectA = yield* Neon.Project("ReplaceBranchProjectA");
          const projectB = yield* Neon.Project("ReplaceBranchProjectB");
          const branch = yield* Neon.Branch("ReplaceBranchExistingProject", {
            project: projectA,
          });
          return { projectA, projectB, branch };
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const projectA = yield* Neon.Project("ReplaceBranchProjectA");
          const projectB = yield* Neon.Project("ReplaceBranchProjectB");
          const branch = yield* Neon.Branch("ReplaceBranchExistingProject", {
            project: projectB,
          });
          return { projectA, projectB, branch };
        }),
      );

      expect(replaced.branch.projectId).toEqual(replaced.projectB.projectId);
      expect(replaced.branch.branchId).not.toEqual(initial.branch.branchId);

      const fetched = yield* getProjectBranch({
        project_id: replaced.projectB.projectId,
        branch_id: replaced.branch.branchId,
      });
      expect(fetched.branch.id).toEqual(replaced.branch.branchId);

      const oldBranch = yield* getProjectBranch({
        project_id: initial.projectA.projectId,
        branch_id: initial.branch.branchId,
      }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
      );
      expect(oldBranch).toEqual("not-found");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("replaces branch when project is replaced", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ReplaceProject", {
          region: "aws-us-east-1",
        });
        const branch = yield* Neon.Branch("ReplaceBranchReplaceProject", {
          project,
        });
        return { project, branch };
      }),
    );

    expect(initial.project.region).toEqual("aws-us-east-1");

    // Trigger a replace on the project by changing the region.
    // This should cause the branch to be replaced.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Neon.Project("ReplaceProject", {
          region: "aws-us-west-2",
        });
        const branch = yield* Neon.Branch("ReplaceBranchReplaceProject", {
          project,
        });
        return { project, branch };
      }),
    );

    expect(replaced.project.region).toEqual("aws-us-west-2");
    expect(replaced.branch.projectId).toEqual(replaced.project.projectId);
    expect(replaced.branch.projectId).not.toEqual(initial.project.projectId);
    expect(replaced.branch.branchId).not.toEqual(initial.branch.branchId);

    const fetched = yield* getProjectBranch({
      project_id: replaced.project.projectId,
      branch_id: replaced.branch.branchId,
    });
    expect(fetched.branch.id).toEqual(replaced.branch.branchId);

    const oldBranch = yield* getProjectBranch({
      project_id: initial.project.projectId,
      branch_id: initial.branch.branchId,
    }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );
    expect(oldBranch).toEqual("not-found");

    yield* stack.destroy();
  }).pipe(logLevel),
);

// #736 regression tests: a `creating`-state row persisted before upstream
// Outputs resolve cannot round-trip Output-valued props — they deserialize as
// `undefined`. The engine's recovery paths hand those junk props back to the
// provider as `olds` (Plan.ts calls `read` and then `diff` with
// `olds: oldState.props` for a creating row with no attributes). The provider
// must fall through to the create path instead of crashing in
// `resolveProjectId`.
//
// Shared shape (Variant B): deploy a project + branch, rewrite the branch's
// persisted row into the wedged creating-state shape, delete the branch
// out-of-band so recovery must recreate it, redeploy, and assert convergence.

/** Rewrite the deployed branch's state row into a wedged `creating` row. */
const wedgeBranchRow = (stack: { name: string }, project: unknown) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const stage = "test"; // scratch stacks default to the "test" stage
    const fqns = yield* state.list({ stack: stack.name, stage });
    const rows = yield* Effect.forEach(fqns, (fqn) =>
      state
        .get({ stack: stack.name, stage, fqn })
        .pipe(Effect.map((row) => ({ fqn, row }))),
    );
    const wedged = rows.find(
      (r): r is { fqn: string; row: ResourceState } =>
        isResourceState(r.row) && r.row.resourceType === "Neon.Branch",
    );
    if (!wedged) {
      return yield* Effect.die(
        new Error("no Neon.Branch state row found after deploy"),
      );
    }
    yield* state.set({
      stack: stack.name,
      stage,
      fqn: wedged.fqn,
      value: {
        ...wedged.row,
        status: "creating",
        attr: undefined,
        props: {
          ...wedged.row.props,
          project,
        },
      },
    });
  });

/** Delete the branch out-of-band and wait (bounded) until it is gone. */
const deleteBranchOutOfBand = (projectId: string, branchId: string) =>
  Effect.gen(function* () {
    yield* deleteProjectBranch({
      project_id: projectId,
      branch_id: branchId,
    }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    const gone = yield* getProjectBranch({
      project_id: projectId,
      branch_id: branchId,
    }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s === "gone",
        times: 10,
      }),
    );
    expect(gone).toEqual("gone");
  });

// `read` guard: the project reference survived the creating-state round-trip
// as an object, but its Output-valued `projectId` did not. Pre-fix, `read`
// crashed with `Error: Invalid Neon project source: must be a Project or
// { projectId }` (thrown by `resolveProjectId`); post-fix it returns
// `undefined` and recovery recreates the branch.
test.provider(
  "recovers a creating-state branch whose project lost its Output-valued projectId (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployBranch = () =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Neon.Project("WedgedReadProject");
            const branch = yield* Neon.Branch("WedgedReadBranch", { project });
            return { project, branch };
          }),
        );

      const initial = yield* deployBranch();

      // The #736 shape for the `read` guard: the object survived but the
      // Output-valued `projectId` inside it deserialized as `undefined`.
      yield* wedgeBranchRow(stack, { projectId: undefined });

      // Delete the branch out-of-band so recovery must recreate it (a
      // recovery `read` returning attributes would skip the create path).
      yield* deleteBranchOutOfBand(
        initial.project.projectId,
        initial.branch.branchId,
      );

      const recovered = yield* deployBranch();
      expect(recovered.branch.branchId).toBeDefined();
      expect(recovered.branch.branchId).not.toEqual(initial.branch.branchId);
      expect(recovered.branch.projectId).toEqual(recovered.project.projectId);
      expect(recovered.branch.branchName).toEqual(initial.branch.branchName);

      const fetched = yield* getProjectBranch({
        project_id: recovered.project.projectId,
        branch_id: recovered.branch.branchId,
      });
      expect(fetched.branch.id).toEqual(recovered.branch.branchId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// `diff` guard: the whole `project` prop deserialized as `undefined`. `read`
// falls through on `!olds?.project` (both pre- and post-fix), so the engine
// then calls `diff` with the junk olds. Pre-fix, `diff` crashed in
// `resolveProjectId(undefined)`; post-fix the unknown old project id falls
// through to the create/update recovery path (no forced replacement).
test.provider(
  "recovers a creating-state branch whose project prop was lost entirely (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployBranch = () =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Neon.Project("WedgedDiffProject");
            const branch = yield* Neon.Branch("WedgedDiffBranch", { project });
            return { project, branch };
          }),
        );

      const initial = yield* deployBranch();

      // The #736 shape for the `diff` guard: the entire Output-valued
      // `project` prop deserialized as `undefined`.
      yield* wedgeBranchRow(stack, undefined);

      yield* deleteBranchOutOfBand(
        initial.project.projectId,
        initial.branch.branchId,
      );

      const recovered = yield* deployBranch();
      expect(recovered.branch.branchId).toBeDefined();
      expect(recovered.branch.branchId).not.toEqual(initial.branch.branchId);
      expect(recovered.branch.projectId).toEqual(recovered.project.projectId);
      expect(recovered.branch.branchName).toEqual(initial.branch.branchName);

      const fetched = yield* getProjectBranch({
        project_id: recovered.project.projectId,
        branch_id: recovered.branch.branchId,
      });
      expect(fetched.branch.id).toEqual(recovered.branch.branchId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
