import type { ProjectCheckoutInspection, ProjectInspectCheckoutInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const NOT_A_CHECKOUT: ProjectCheckoutInspection = { projectId: null, checkout: null };

// Adding a project works without this answer, so a hung mount must not hold that flow up.
const INSPECTION_TIMEOUT = Duration.seconds(5);
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const PROJECT_ROOT_RESOLUTION_CONCURRENCY = 8;

export class ProjectCheckoutInspector extends Context.Service<
  ProjectCheckoutInspector,
  {
    /** The folder is not trusted yet, so this never runs `git status`, which can start its fsmonitor. */
    readonly inspect: (
      input: ProjectInspectCheckoutInput,
    ) => Effect.Effect<ProjectCheckoutInspection>;
  }
>()("t3/project/ProjectCheckoutInspector") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const physicalPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));

  const readWorkingTree = Effect.fn("ProjectCheckoutInspector.readWorkingTree")(function* (
    cwd: string,
  ) {
    const revParse = yield* git.execute({
      operation: "ProjectCheckoutInspector.revParse",
      cwd,
      args: [
        "rev-parse",
        "--show-toplevel",
        "--absolute-git-dir",
        "--git-common-dir",
        "--show-prefix",
      ],
      allowNonZeroExit: true,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    if (revParse.exitCode !== 0) return null;
    // Only the newline ends a value: whitespace around it belongs to the path.
    const [topLevel, gitDir, commonDir, prefix] = revParse.stdout.split("\n");
    if (!topLevel || !gitDir || !commonDir || prefix === undefined) return null;

    const head = yield* git.execute({
      operation: "ProjectCheckoutInspector.head",
      cwd,
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    const headRef = head.exitCode === 0 ? head.stdout.trim() : "";

    // Git reports a relative common directory from the physical cwd, which a symlink can hide.
    const physicalCwd = yield* physicalPath(cwd);
    const physicalGitDir = yield* physicalPath(gitDir);
    const physicalCommonDir = yield* physicalPath(path.resolve(physicalCwd, commonDir));
    return {
      topLevel: path.normalize(topLevel),
      isNested: prefix.length > 0,
      branch: headRef.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : null,
      isLinkedWorktree: path.relative(physicalCommonDir, physicalGitDir) !== "",
    };
  });

  const inspectSelected = Effect.fn("ProjectCheckoutInspector.inspectSelected")(function* (
    selectedPath: string,
  ) {
    const workingTree = yield* readWorkingTree(selectedPath).pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          Effect.logWarning("Could not inspect the folder with Git", { cause }).pipe(
            Effect.as(null),
          ),
      }),
    );

    // Registered roots keep the spelling they were added with, often through a symlink.
    const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
    const registered = yield* Effect.forEach(
      shells,
      (shell) =>
        physicalPath(shell.workspaceRoot).pipe(
          Effect.map((physicalRoot) => ({ id: shell.id, physicalRoot })),
        ),
      { concurrency: PROJECT_ROOT_RESOLUTION_CONCURRENCY },
    );
    const projectIdAt = (physical: string) =>
      registered.find(({ physicalRoot }) => path.relative(physicalRoot, physical) === "")?.id ??
      null;

    const projectId = projectIdAt(yield* physicalPath(selectedPath));
    if (workingTree === null) return { projectId, checkout: null };
    return {
      projectId,
      checkout: {
        selectedPath,
        root: workingTree.isNested ? workingTree.topLevel : selectedPath,
        rootProjectId: workingTree.isNested
          ? projectIdAt(yield* physicalPath(workingTree.topLevel))
          : projectId,
        branch: workingTree.branch,
        isLinkedWorktree: workingTree.isLinkedWorktree,
      },
    };
  });

  const inspect: ProjectCheckoutInspector["Service"]["inspect"] = Effect.fn(
    "ProjectCheckoutInspector.inspect",
  )(function* (input) {
    const selectedPath = yield* workspacePaths
      .normalizeWorkspaceRoot(input.path)
      .pipe(Effect.option);
    if (Option.isNone(selectedPath)) return NOT_A_CHECKOUT;
    return yield* inspectSelected(selectedPath.value).pipe(
      Effect.timeoutOption(INSPECTION_TIMEOUT),
      Effect.map(Option.getOrElse(() => NOT_A_CHECKOUT)),
    );
  });

  return ProjectCheckoutInspector.of({ inspect });
});

export const layer = Layer.effect(ProjectCheckoutInspector, make);
