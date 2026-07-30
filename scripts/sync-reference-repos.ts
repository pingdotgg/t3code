#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { referenceRepos, type ReferenceRepo } from "./lib/reference-repos.ts";

export type ReferenceRepoSyncAction = "add" | "pull";

export interface ReferenceRepoSyncOptions {
  readonly rootDir?: string | undefined;
  readonly repoId?: string | undefined;
  readonly latest?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface ReferenceRepoSyncPlan {
  readonly repo: ReferenceRepo;
  readonly action: ReferenceRepoSyncAction;
  readonly ref: string;
  readonly args: ReadonlyArray<string>;
}

export class ReferenceRepoSelectionError extends Schema.TaggedErrorClass<ReferenceRepoSelectionError>()(
  "ReferenceRepoSelectionError",
  {
    repoId: Schema.String,
    expectedRepoIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Unknown reference repo "${this.repoId}". Expected one of: ${this.expectedRepoIds.join(", ")}.`;
  }
}

export class ReferenceRepoVersionSourceError extends Schema.TaggedErrorClass<ReferenceRepoVersionSourceError>()(
  "ReferenceRepoVersionSourceError",
  {
    operation: Schema.Literals(["read", "parse"]),
    repoId: Schema.String,
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Reference repo "${this.repoId}" version source operation "${this.operation}" failed for ${this.sourcePath}.`;
  }
}

export class ReferenceRepoVersionResolutionError extends Schema.TaggedErrorClass<ReferenceRepoVersionResolutionError>()(
  "ReferenceRepoVersionResolutionError",
  {
    repoId: Schema.String,
    sourcePath: Schema.String,
    packageVersionPath: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No version was found for reference repo "${this.repoId}" at ${this.sourcePath}:${this.packageVersionPath.join(".")}.`;
  }
}

export class ReferenceRepoGitSubtreeError extends Schema.TaggedErrorClass<ReferenceRepoGitSubtreeError>()(
  "ReferenceRepoGitSubtreeError",
  {
    operation: Schema.Literals(["spawn", "communicate", "exit"]),
    repoId: Schema.String,
    action: Schema.Literals(["add", "pull"]),
    repository: Schema.String,
    ref: Schema.String,
    rootDir: Schema.String,
    argumentCount: Schema.Number,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Git subtree ${this.action} for reference repo "${this.repoId}" failed during "${this.operation}".`;
  }
}

export const ReferenceRepoSyncError = Schema.Union([
  ReferenceRepoSelectionError,
  ReferenceRepoVersionSourceError,
  ReferenceRepoVersionResolutionError,
  ReferenceRepoGitSubtreeError,
]);
export type ReferenceRepoSyncError = typeof ReferenceRepoSyncError.Type;
export const isReferenceRepoSyncError = Schema.is(ReferenceRepoSyncError);

const decodeJsonSource = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeYamlSource = Schema.decodeEffect(fromYaml(Schema.Unknown));

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function readNestedString(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  let value = input;
  for (const key of keys) {
    if (typeof value !== "object" || value === null || !(key in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeVersionSource(
  repo: ReferenceRepo,
  sourcePath: string,
  content: string,
): Effect.Effect<unknown, ReferenceRepoSyncError> {
  const decode =
    repo.versionSourcePath.endsWith(".yaml") || repo.versionSourcePath.endsWith(".yml")
      ? decodeYamlSource
      : decodeJsonSource;
  return decode(content).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoVersionSourceError({
          operation: "parse",
          repoId: repo.id,
          sourcePath,
          cause,
        }),
    ),
  );
}

function getSelectedRepos(
  repoId: string | undefined,
): Effect.Effect<ReadonlyArray<ReferenceRepo>, ReferenceRepoSyncError> {
  if (!repoId) {
    return Effect.succeed(referenceRepos);
  }

  const repo = referenceRepos.find((candidate) => candidate.id === repoId);
  return repo
    ? Effect.succeed([repo])
    : Effect.fail(
        new ReferenceRepoSelectionError({
          repoId,
          expectedRepoIds: referenceRepos.map((candidate) => candidate.id),
        }),
      );
}

export const resolveReferenceRepoRef = Effect.fn("resolveReferenceRepoRef")(function* (
  repo: ReferenceRepo,
  rootDir: string,
  latest: boolean,
) {
  if (latest) {
    return repo.latestRef;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionSourcePath = path.join(rootDir, repo.versionSourcePath);
  const versionSourceContent = yield* fs.readFileString(versionSourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoVersionSourceError({
          operation: "read",
          repoId: repo.id,
          sourcePath: versionSourcePath,
          cause,
        }),
    ),
  );
  const versionSource = yield* decodeVersionSource(repo, versionSourcePath, versionSourceContent);
  const version = readNestedString(versionSource, repo.packageVersionPath);

  if (!version) {
    return yield* new ReferenceRepoVersionResolutionError({
      repoId: repo.id,
      sourcePath: versionSourcePath,
      packageVersionPath: repo.packageVersionPath,
    });
  }

  return `${repo.versionTagPrefix}${version}`;
});

export const planReferenceRepoSync = Effect.fn("planReferenceRepoSync")(function* (
  repo: ReferenceRepo,
  rootDir: string,
  latest: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const action: ReferenceRepoSyncAction = (yield* fs.exists(path.join(rootDir, repo.prefix)))
    ? "pull"
    : "add";
  const ref = yield* resolveReferenceRepoRef(repo, rootDir, latest);

  return {
    repo,
    action,
    ref,
    args: ["subtree", action, `--prefix=${repo.prefix}`, repo.repository, ref, "--squash"],
  } satisfies ReferenceRepoSyncPlan;
});

const runGit = Effect.fn("runGit")(function* (rootDir: string, plan: ReferenceRepoSyncPlan) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const errorContext = {
    repoId: plan.repo.id,
    action: plan.action,
    repository: plan.repo.repository,
    ref: plan.ref,
    rootDir,
    argumentCount: plan.args.length,
  } as const;
  const child = yield* spawner.spawn(ChildProcess.make("git", plan.args, { cwd: rootDir })).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoGitSubtreeError({
          ...errorContext,
          operation: "spawn",
          cause,
        }),
    ),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoGitSubtreeError({
          ...errorContext,
          operation: "communicate",
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new ReferenceRepoGitSubtreeError({
      ...errorContext,
      operation: "exit",
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });
  }

  if (stdout.trim().length > 0) {
    yield* Console.log(stdout.trim());
  }
});

export const syncReferenceRepos = Effect.fn("syncReferenceRepos")(function* (
  options: ReferenceRepoSyncOptions = {},
) {
  const path = yield* Path.Path;
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const repos = yield* getSelectedRepos(options.repoId);
  const plans: Array<ReferenceRepoSyncPlan> = [];

  for (const repo of repos) {
    const plan = yield* planReferenceRepoSync(repo, rootDir, options.latest ?? false);
    plans.push(plan);
    yield* Console.log(`Syncing ${repo.id} from ${plan.ref} with git subtree ${plan.action}.`);
    if (!(options.dryRun ?? false)) {
      yield* runGit(rootDir, plan).pipe(Effect.scoped);
    }
  }

  return plans;
});

export const syncReferenceReposCommand = Command.make(
  "sync-reference-repos",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Sync only the named reference repo. Defaults to all configured repos."),
      Flag.optional,
    ),
    latest: Flag.boolean("latest").pipe(
      Flag.withDescription(
        "Sync each repo from its latest branch instead of the installed version.",
      ),
      Flag.withDefault(false),
    ),
    root: Flag.string("root").pipe(
      Flag.withDescription("Workspace root used to resolve versions and subtree prefixes."),
      Flag.optional,
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Print planned subtree operations without running git."),
      Flag.withDefault(false),
    ),
  },
  ({ repo, latest, root, dryRun }) =>
    syncReferenceRepos({
      repoId: Option.getOrUndefined(repo),
      rootDir: Option.getOrUndefined(root),
      latest,
      dryRun,
    }),
).pipe(Command.withDescription("Sync vendored reference repositories under .repos/."));

if (import.meta.main) {
  Command.run(syncReferenceReposCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
