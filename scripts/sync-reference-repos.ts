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
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { referenceRepos, type ReferenceRepo } from "./lib/reference-repos.ts";

export interface ReferenceRepoSyncOptions {
  readonly rootDir?: string | undefined;
  readonly repoId?: string | undefined;
  readonly latest?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface ReferenceRepoSyncPlan {
  readonly repo: ReferenceRepo;
  readonly ref: string;
  /** `git clone` arguments, without the destination directory. */
  readonly cloneArgs: ReadonlyArray<string>;
}

export class ReferenceRepoSelectionError extends Schema.TaggedError<ReferenceRepoSelectionError>()(
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

export class ReferenceRepoVersionSourceError extends Schema.TaggedError<ReferenceRepoVersionSourceError>()(
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

export class ReferenceRepoVersionResolutionError extends Schema.TaggedError<ReferenceRepoVersionResolutionError>()(
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

export class ReferenceRepoGitError extends Schema.TaggedError<ReferenceRepoGitError>()(
  "ReferenceRepoGitError",
  {
    operation: Schema.Literals(["spawn", "communicate", "exit"]),
    repoId: Schema.String,
    command: Schema.String,
    ref: Schema.String,
    cwd: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.stderr ? `: ${this.stderr.trim()}` : "";
    return `git ${this.command} for reference repo "${this.repoId}" at ${this.ref} failed during "${this.operation}"${detail}`;
  }
}

export class ReferenceRepoFileSystemError extends Schema.TaggedError<ReferenceRepoFileSystemError>()(
  "ReferenceRepoFileSystemError",
  {
    repoId: Schema.String,
    prefix: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Replacing ${this.prefix} for reference repo "${this.repoId}" failed.`;
  }
}

export type ReferenceRepoSyncError =
  | ReferenceRepoSelectionError
  | ReferenceRepoVersionSourceError
  | ReferenceRepoVersionResolutionError
  | ReferenceRepoGitError
  | ReferenceRepoFileSystemError;

const decodeJsonSource = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
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

/**
 * Shallow-clone the upstream ref into a temp dir and copy its files into `.repos/<id>`.
 * Never fetch upstream into this repo: its tags and shallow boundaries break `git fetch`.
 */
export const planReferenceRepoSync = Effect.fn("planReferenceRepoSync")(function* (
  repo: ReferenceRepo,
  rootDir: string,
  latest: boolean,
) {
  const ref = yield* resolveReferenceRepoRef(repo, rootDir, latest);

  return {
    repo,
    ref,
    cloneArgs: [
      "clone",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--single-branch",
      `--branch=${ref}`,
      repo.repository,
    ],
  } satisfies ReferenceRepoSyncPlan;
});

const runGit = Effect.fn("runGit")(function* (
  plan: ReferenceRepoSyncPlan,
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const errorContext = {
    repoId: plan.repo.id,
    command: args[0] ?? "",
    ref: plan.ref,
    cwd,
  } as const;
  const child = yield* spawner
    .spawn(ChildProcess.make("git", [...args], { cwd }))
    .pipe(
      Effect.mapError(
        (cause) => new ReferenceRepoGitError({ ...errorContext, operation: "spawn", cause }),
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
      (cause) => new ReferenceRepoGitError({ ...errorContext, operation: "communicate", cause }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new ReferenceRepoGitError({
      ...errorContext,
      operation: "exit",
      exitCode,
      stderr,
    });
  }

  return stdout;
});

const applyReferenceRepoSync = Effect.fn("applyReferenceRepoSync")(function* (
  rootDir: string,
  plan: ReferenceRepoSyncPlan,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { repo } = plan;
  const target = path.join(rootDir, repo.prefix);
  const mapFsError = Effect.mapError(
    (cause: unknown) =>
      new ReferenceRepoFileSystemError({ repoId: repo.id, prefix: repo.prefix, cause }),
  );

  // Clone next to the target so a rename moves it into place: same filesystem, and
  // relative symlinks stay relative (`fs.copy` rewrites them to absolute temp paths).
  yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(mapFsError);
  const tempDir = yield* fs
    .makeTempDirectoryScoped({ directory: path.dirname(target), prefix: `.sync-${repo.id}-` })
    .pipe(mapFsError);
  const checkout = path.join(tempDir, "checkout");
  yield* runGit(plan, rootDir, [...plan.cloneArgs, checkout]);
  const commit = (yield* runGit(plan, checkout, ["rev-parse", "HEAD"])).trim();

  yield* Effect.gen(function* () {
    yield* fs.remove(path.join(checkout, ".git"), { recursive: true });
    yield* fs.remove(target, { recursive: true, force: true });
    yield* fs.rename(checkout, target);
  }).pipe(mapFsError);

  yield* runGit(plan, rootDir, ["add", "--all", "--", repo.prefix]);
  const status = yield* runGit(plan, rootDir, ["status", "--porcelain", "--", repo.prefix]);
  if (status.trim().length === 0) {
    yield* Console.log(`${repo.id} is already at ${plan.ref}.`);
    return;
  }
  yield* runGit(plan, rootDir, [
    "commit",
    "--quiet",
    "--message",
    `chore(repos): sync ${repo.id} to ${plan.ref}\n\nUpstream: ${repo.repository} ${commit}`,
    "--",
    repo.prefix,
  ]);
  yield* Console.log(`Committed ${repo.prefix} at ${plan.ref} (${commit.slice(0, 12)}).`);
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
    yield* Console.log(`Syncing ${repo.id} from ${plan.ref} (shallow clone, no history).`);
    if (!(options.dryRun ?? false)) {
      yield* applyReferenceRepoSync(rootDir, plan).pipe(Effect.scoped);
    }
  }

  return plans;
});

export const syncReferenceReposCommand = Command.make(
  "sync-reference-repos",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Sync only the named reference repo. Defaults to all configured repos."),
      Flag.optional,
    ),
    latest: Flag.Boolean("latest").pipe(
      Flag.withDescription(
        "Sync each repo from its latest branch instead of the installed version.",
      ),
      Flag.withDefault(false),
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription("Workspace root used to resolve versions and .repos/ prefixes."),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the planned syncs without cloning or committing."),
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
