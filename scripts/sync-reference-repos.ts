#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

export class ReferenceRepoSyncError extends Data.TaggedError("ReferenceRepoSyncError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const decodePackageJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

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
        new ReferenceRepoSyncError({
          message: `Unknown reference repo '${repoId}'. Expected one of: ${referenceRepos
            .map((candidate) => candidate.id)
            .join(", ")}.`,
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
  const packageJsonPath = path.join(rootDir, repo.packageJsonPath);
  const packageJson = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.flatMap(decodePackageJson),
    Effect.mapError(
      (cause) =>
        new ReferenceRepoSyncError({
          message: `Unable to read package version for '${repo.id}' from ${packageJsonPath}.`,
          cause,
        }),
    ),
  );
  const version = readNestedString(packageJson, repo.packageVersionPath);

  if (!version) {
    return yield* new ReferenceRepoSyncError({
      message: `Unable to resolve package version for '${repo.id}' at ${repo.packageJsonPath}:${repo.packageVersionPath.join(
        ".",
      )}.`,
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
  const child = yield* spawner.spawn(ChildProcess.make("git", plan.args, { cwd: rootDir })).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoSyncError({
          message: `Unable to start git subtree ${plan.action} for '${plan.repo.id}'.`,
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
        new ReferenceRepoSyncError({
          message: `Unable to run git subtree ${plan.action} for '${plan.repo.id}'.`,
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new ReferenceRepoSyncError({
      message: `git subtree ${plan.action} failed for '${plan.repo.id}' with exit code ${exitCode}.\n${stderr.trim()}`,
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
