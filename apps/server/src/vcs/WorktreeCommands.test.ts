import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type Project, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorktreeCommands from "./WorktreeCommands.ts";

const projectId = ProjectId.make("project-custom-worktrees");

function makeLayer(settings: Parameters<typeof ServerSettings.layerTest>[0]) {
  return Layer.effect(WorktreeCommands.WorktreeCommands, WorktreeCommands.make).pipe(
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getByWorkspaceRoot: (workspaceRoot) =>
          Effect.succeed(
            workspaceRoot === "/repo"
              ? Option.some({ id: projectId } as unknown as Project)
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(ProcessRunner.layer),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("reportedCheckoutPath", () => {
  it("takes an absolute path on the last line of output", () => {
    assert.equal(
      WorktreeCommands.reportedCheckoutPath("Created workspace: feat\n/work/repo.feat\n"),
      "/work/repo.feat",
    );
    assert.equal(
      WorktreeCommands.reportedCheckoutPath("done\r\nC:\\work\\feat\r\n"),
      "C:\\work\\feat",
    );
  });

  it("reports nothing when the output does not end with an absolute path", () => {
    assert.isNull(WorktreeCommands.reportedCheckoutPath(""));
    assert.isNull(WorktreeCommands.reportedCheckoutPath("/work/repo.feat\nPreparing worktree"));
    assert.isNull(WorktreeCommands.reportedCheckoutPath("relative/path"));
  });
});

describe("WorktreeCommands", () => {
  it.effect("applies the project's override on top of the environment commands", () =>
    Effect.gen(function* () {
      const commands = yield* WorktreeCommands.WorktreeCommands;

      assert.deepStrictEqual(yield* commands.resolve("/repo"), {
        create: "project-create",
        remove: "",
      });
      assert.deepStrictEqual(yield* commands.resolve("/elsewhere"), {
        create: "environment-create",
        remove: "environment-remove",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          worktreeCommands: { create: "environment-create", remove: "environment-remove" },
          projectSettingsOverrides: {
            [projectId]: { worktreeCommands: { create: "project-create", remove: "" } },
          },
        }),
      ),
    ),
  );

  it.effect("runs the command in the project with its T3CODE_* environment", () =>
    Effect.gen(function* () {
      const commands = yield* WorktreeCommands.WorktreeCommands;
      const cwd = process.cwd();

      yield* commands.run({
        operation: "test",
        command: 'test "$T3CODE_BRANCH" = feature && test "$PWD" = "$T3CODE_PROJECT_ROOT"',
        projectCwd: cwd,
        env: WorktreeCommands.worktreeCreateCommandEnv(cwd, {
          worktreePath: "/worktrees/feature",
          branch: "feature",
          startRef: "main",
          createBranch: true,
        }),
      });
    }).pipe(Effect.provide(makeLayer({}))),
  );

  it.effect("fails with the command's own output on a non-zero exit", () =>
    Effect.gen(function* () {
      const commands = yield* WorktreeCommands.WorktreeCommands;

      const error = yield* Effect.flip(
        commands.run({
          operation: "test",
          command: "echo 'disk quota exceeded' >&2; exit 3",
          projectCwd: process.cwd(),
          env: {},
        }),
      );

      assert.include(error.detail, "exited with code 3");
      assert.include(error.detail, "disk quota exceeded");
    }).pipe(Effect.provide(makeLayer({}))),
  );
});
