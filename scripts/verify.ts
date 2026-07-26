#!/usr/bin/env node

/**
 * Run the checks a change actually needs, instead of the checks the whole
 * monorepo needs.
 *
 * `vp check` + `vp run -r typecheck` + `vp run -r test` + `swift test` is the
 * right gate before a PR and the wrong gate after every edit: it re-runs 411
 * TypeScript test files and relinks a 500-test Swift suite to prove that a
 * one-file change to `packages/shared` is fine. This script resolves the
 * changed files against the workspace and runs only the affected slice.
 *
 * Usage:
 *   node scripts/verify.ts            # everything the working diff touches
 *   node scripts/verify.ts --base HEAD~3
 *   node scripts/verify.ts --all      # the full pre-PR gate
 *   node scripts/verify.ts --dry-run  # print the plan, run nothing
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  dependentFilters,
  resolveChangedScope,
  type ChangedScope,
  type WorkspacePackage,
} from "./lib/changed-scope.ts";

export class VerifyProcessError extends Schema.TaggedErrorClass<VerifyProcessError>()(
  "VerifyProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    command: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Verify step '${this.command}' failed to ${this.operation === "spawn" ? "start" : "complete"}.`;
  }
}

export class VerifyStepFailedError extends Schema.TaggedErrorClass<VerifyStepFailedError>()(
  "VerifyStepFailedError",
  {
    step: Schema.String,
    command: Schema.String,
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `${this.step} failed (exit ${this.exitCode}): ${this.command}`;
  }
}

export class VerifyWorkspaceError extends Schema.TaggedErrorClass<VerifyWorkspaceError>()(
  "VerifyWorkspaceError",
  {
    operation: Schema.Literals(["read-package-json", "list-directory", "resolve-root"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace discovery operation '${this.operation}' failed for '${this.path}'.`;
  }
}

/**
 * Directories that hold workspace packages, mirroring `pnpm-workspace.yaml`.
 *
 * Kept as a literal list rather than a YAML parse because the globs there are
 * all a single level deep, and a wrong answer here silently under-runs tests.
 */
const packageParents = ["apps", "infra", "packages"] as const;
const standalonePackages = ["oxlint-plugin-t3code", "scripts"] as const;

/** Only the package name matters here; everything else in package.json is noise. */
const NamedPackageJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.optional(Schema.String) }),
);
const decodePackageJson = Schema.decodeUnknownEffect(NamedPackageJson);

const readPackageName = Effect.fn("readPackageName")(function* (packageJsonPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(packageJsonPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return null;
  }
  const contents = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.mapError(
      (cause) =>
        new VerifyWorkspaceError({
          operation: "read-package-json",
          path: packageJsonPath,
          cause,
        }),
    ),
  );
  const parsed = yield* decodePackageJson(contents).pipe(
    Effect.mapError(
      (cause) =>
        new VerifyWorkspaceError({
          operation: "read-package-json",
          path: packageJsonPath,
          cause,
        }),
    ),
  );
  return parsed.name ?? null;
});

/** Every workspace package, as `{ name, directory }` with repo-relative dirs. */
export const discoverWorkspacePackages = Effect.fn("discoverWorkspacePackages")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packages: WorkspacePackage[] = [];

  const record = Effect.fn("record")(function* (directory: string) {
    const name = yield* readPackageName(path.join(root, directory, "package.json"));
    if (name !== null) {
      packages.push({ name, directory });
    }
  });

  for (const parent of packageParents) {
    const parentPath = path.join(root, parent);
    const exists = yield* fs.exists(parentPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      continue;
    }
    const entries = yield* fs
      .readDirectory(parentPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new VerifyWorkspaceError({ operation: "list-directory", path: parentPath, cause }),
        ),
      );
    for (const entry of [...entries].sort()) {
      yield* record(`${parent}/${entry}`);
    }
  }
  for (const directory of standalonePackages) {
    yield* record(directory);
  }

  return packages;
});

const captureCommand = Effect.fn("captureCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(command, args);
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError((cause) => new VerifyProcessError({ operation: "spawn", command, cause })),
    );
  const stdout = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulated, chunk) => accumulated + chunk,
    ),
    Effect.mapError(
      (cause) => new VerifyProcessError({ operation: "wait-for-exit", command, cause }),
    ),
  );
  const exitCode = Number(
    yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) => new VerifyProcessError({ operation: "wait-for-exit", command, cause }),
      ),
    ),
  );
  // A failing `git diff` would otherwise read as "no files changed", and this
  // tool answering "nothing to verify" when it simply could not look is the
  // one failure mode that must never be quiet.
  if (exitCode !== 0) {
    return yield* new VerifyStepFailedError({
      step: "resolve changed files",
      command: [command, ...args].join(" "),
      exitCode,
    });
  }
  return stdout;
});

const runStep = Effect.fn("runStep")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  yield* Console.log(`\n▸ ${step}\n  $ ${[command, ...args].join(" ")}`);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(command, args);
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError((cause) => new VerifyProcessError({ operation: "spawn", command, cause })),
    );
  const exitCode = Number(
    yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) => new VerifyProcessError({ operation: "wait-for-exit", command, cause }),
      ),
    ),
  );
  if (exitCode !== 0) {
    return yield* new VerifyStepFailedError({
      step,
      command: [command, ...args].join(" "),
      exitCode,
    });
  }
});

/**
 * Files changed relative to `base`, plus anything uncommitted.
 *
 * Untracked files count: a brand-new module with a brand-new test is exactly
 * the case where skipping it would be worst.
 */
const changedFiles = Effect.fn("changedFiles")(function* (root: string, base: string) {
  const diff = yield* captureCommand("git", ["diff", "--name-only", `${base}...HEAD`], root);
  const working = yield* captureCommand("git", ["diff", "--name-only", "HEAD"], root);
  const untracked = yield* captureCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    root,
  );
  return [
    ...new Set(
      [diff, working, untracked]
        .flatMap((output) => output.split("\n"))
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ].sort();
});

/** A verification step: a label plus the command that proves it. */
interface Step {
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Turn a resolved scope into the ordered list of commands to run.
 *
 * Exported for tests: the plan is the interesting part, and it can be asserted
 * without spawning anything.
 */
export function planSteps(scope: ChangedScope, options: { readonly all: boolean }): Step[] {
  const full = options.all || scope.touchesWorkspaceRoot;
  const steps: Step[] = [];

  if (full) {
    steps.push(
      { label: "check (all)", command: "vp", args: ["check"] },
      {
        label: "typecheck (all)",
        command: "vp",
        args: ["run", "-r", "--concurrency-limit", "2", "typecheck"],
      },
      { label: "test (all)", command: "vp", args: ["run", "-r", "test"] },
    );
  } else {
    if (scope.checkPaths.length > 0) {
      steps.push({
        label: "check (changed files)",
        command: "vp",
        args: ["check", ...scope.checkPaths],
      });
    }
    if (scope.packages.length > 0) {
      steps.push({
        label: `typecheck (${scope.packages.join(", ")} + dependents)`,
        command: "vp",
        args: ["run", ...dependentFilters(scope.packages), "--concurrency-limit", "2", "typecheck"],
      });
    }
    if (scope.relatedSources.length > 0) {
      steps.push({
        label: "test (related)",
        command: "vp",
        args: ["test", "related", "--run", ...scope.relatedSources],
      });
    }
  }

  if (full || scope.touchesMac) {
    steps.push({
      label: "swift test (apps/mac)",
      command: "apps/mac/scripts/swift-test.sh",
      args: [],
    });
  }
  if (full || scope.touchesMobileNative) {
    steps.push({ label: "lint:mobile", command: "vp", args: ["run", "lint:mobile"] });
  }

  return steps;
}

const runVerify = Effect.fn("runVerify")(function* (options: {
  readonly base: string;
  readonly all: boolean;
  readonly dryRun: boolean;
}) {
  const path = yield* Path.Path;
  const root = (yield* captureCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    process.cwd(),
  )).trim();
  if (root === "") {
    return yield* new VerifyWorkspaceError({
      operation: "resolve-root",
      path: process.cwd(),
      cause: "git rev-parse --show-toplevel produced no output",
    });
  }

  const packages = yield* discoverWorkspacePackages(root);
  const files = options.all ? [] : yield* changedFiles(root, options.base);
  const scope = resolveChangedScope(files, packages);
  const steps = planSteps(scope, { all: options.all });

  if (options.all) {
    yield* Console.log("Scope: full suite (--all).");
  } else if (scope.touchesWorkspaceRoot) {
    yield* Console.log(
      `Scope: ${files.length} changed file(s) vs ${options.base} — a workspace-root input ` +
        "changed, so the full suite is the only trustworthy answer.",
    );
  } else {
    const affected = [
      ...scope.packages,
      ...(scope.touchesMac ? ["apps/mac (Swift)"] : []),
      ...(scope.touchesMobileNative ? ["mobile native sources"] : []),
    ];
    yield* Console.log(
      `Scope: ${files.length} changed file(s) vs ${options.base} → ` +
        (affected.length > 0 ? affected.join(", ") : "nothing checkable"),
    );
  }

  if (steps.length === 0) {
    yield* Console.log("Nothing to verify — no checkable files changed.");
    return;
  }

  if (options.dryRun) {
    for (const step of steps) {
      yield* Console.log(`  ${step.label}: ${[step.command, ...step.args].join(" ")}`);
    }
    return;
  }

  for (const step of steps) {
    const command = step.command.startsWith("apps/") ? path.join(root, step.command) : step.command;
    yield* runStep(step.label, command, step.args, root);
  }
  yield* Console.log(`\n✔ ${steps.length} verification step(s) passed.`);
});

export const verifyCommand = Command.make(
  "verify",
  {
    base: Flag.string("base").pipe(
      Flag.withDefault("origin/main"),
      Flag.withDescription("Git ref to diff against when selecting changed files."),
    ),
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Run the full pre-PR gate instead of the changed slice."),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Print the resolved plan without running anything."),
    ),
  },
  (options) => runVerify(options),
).pipe(Command.withDescription("Run only the checks the current change needs."));

if (import.meta.main) {
  Command.run(verifyCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
