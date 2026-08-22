import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ProjectScaffoldError,
  type ProjectScaffoldInput,
  type ProjectScaffoldResult,
} from "@t3tools/contracts";
import { generateProjectFaviconSvg, generateProjectReadme } from "@t3tools/shared/projectScaffold";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const isProjectScaffoldError = Schema.is(ProjectScaffoldError);

// Fallback identity for the initial commit when the machine has no git
// user.name/user.email configured. The commit genuinely comes from the tool,
// and a first-run user should not hit a git config error here.
const FALLBACK_COMMIT_IDENTITY = {
  name: "T3 Code",
  email: "noreply@t3.gg",
} as const;

/**
 * Creates a brand-new project folder: mkdir, `git init -b main`, README.md and
 * a generated favicon.svg, then one initial commit. The initial commit is
 * mandatory — thread start creates a worktree from the base branch, and
 * `git worktree add` fails on a repo with an unborn HEAD.
 */
export class ProjectScaffoldService extends Context.Service<
  ProjectScaffoldService,
  {
    readonly scaffold: (
      input: ProjectScaffoldInput,
    ) => Effect.Effect<ProjectScaffoldResult, ProjectScaffoldError>;
  }
>()("t3/project/ProjectScaffoldService") {}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

function mapScaffoldError(operation: string) {
  return Effect.mapError((cause: unknown) =>
    isProjectScaffoldError(cause)
      ? cause
      : new ProjectScaffoldError({
          operation,
          detail: "The project could not be created.",
          cause,
        }),
  );
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;

  const gitConfigValue = (cwd: string, key: string) =>
    git
      .execute({
        operation: "ProjectScaffoldService.readGitConfig",
        cwd,
        args: ["config", "--get", key],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));

  const populateRepository = Effect.fn("ProjectScaffoldService.populateRepository")(function* (
    destination: string,
    name: string,
  ) {
    yield* git.execute({
      operation: "ProjectScaffoldService.gitInit",
      cwd: destination,
      args: ["init", "-b", "main"],
    });

    yield* fileSystem.writeFileString(
      path.join(destination, "README.md"),
      generateProjectReadme(name),
    );
    yield* fileSystem.writeFileString(
      path.join(destination, "favicon.svg"),
      generateProjectFaviconSvg(name),
    );

    yield* git.execute({
      operation: "ProjectScaffoldService.gitAdd",
      cwd: destination,
      args: ["add", "README.md", "favicon.svg"],
    });

    const userName = yield* gitConfigValue(destination, "user.name");
    const userEmail = yield* gitConfigValue(destination, "user.email");
    const identityArgs =
      userName.length > 0 && userEmail.length > 0
        ? []
        : [
            "-c",
            `user.name=${FALLBACK_COMMIT_IDENTITY.name}`,
            "-c",
            `user.email=${FALLBACK_COMMIT_IDENTITY.email}`,
          ];

    yield* git.execute({
      operation: "ProjectScaffoldService.gitCommit",
      cwd: destination,
      args: [...identityArgs, "commit", "-m", "Initial commit"],
    });
  });

  const scaffold = Effect.fn("ProjectScaffoldService.scaffold")(function* (
    input: ProjectScaffoldInput,
  ) {
    const destination = path.resolve(expandHomePath(input.destinationPath.trim(), path));
    const alreadyExists = new ProjectScaffoldError({
      operation: "prepareDestination",
      detail: `A folder already exists at ${destination}.`,
    });

    if (yield* fileSystem.exists(destination).pipe(Effect.orElseSucceed(() => false))) {
      return yield* alreadyExists;
    }

    yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
    // Non-recursive mkdir is the exclusive ownership claim: if a concurrent
    // scaffold created the folder between the check above and here, this fails
    // instead of silently adopting (and later deleting) the other call's repo.
    yield* fileSystem.makeDirectory(destination).pipe(
      Effect.catch((cause) =>
        fileSystem.exists(destination).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((nowExists) => Effect.fail(nowExists ? alreadyExists : cause)),
        ),
      ),
    );

    // Remove the folder this call created when any later step fails, so a
    // retry with the same name starts clean. Parents created by the recursive
    // mkdir are left in place; they are the stable projects root.
    yield* populateRepository(destination, input.name).pipe(
      Effect.onError(() => fileSystem.remove(destination, { recursive: true }).pipe(Effect.ignore)),
    );

    return { cwd: destination };
  });

  return ProjectScaffoldService.of({
    scaffold: (input) => scaffold(input).pipe(mapScaffoldError("scaffold")),
  });
});

export const layer = Layer.effect(ProjectScaffoldService, make);
