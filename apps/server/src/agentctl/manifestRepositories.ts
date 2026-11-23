import type {
  AgentctlManifestRoot,
  AgentctlRepositoryPull,
  AgentctlRepositoryStatus,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { discoverManifests } from "./manifests.ts";

class ManifestRepositoryError extends Schema.TaggedError<ManifestRepositoryError>()(
  "ManifestRepositoryError",
  {
    directory: Schema.String,
    reason: Schema.Literals(["not-found", "failed", "timeout"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `No Git repositories found in ${this.directory}.`;
      case "failed":
        return `Could not run Git in ${this.directory}.`;
      case "timeout":
        return `Git timed out in ${this.directory}.`;
    }
  }
}

const PULL_TIMEOUT = Duration.minutes(2);
// Fetching only refreshes a status line, so a slow remote should not hold it up for long.
const FETCH_TIMEOUT = Duration.seconds(30);

const decodeOutput = (chunks: ReadonlyArray<Uint8Array>) => {
  const decoder = new TextDecoder();
  return (
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode()
  ).trim();
};

const runGit = Effect.fn("AgentctlSandboxes.runManifestGit")(function* (
  directory: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input = PULL_TIMEOUT,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-C", directory, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          // Status runs while the user may be working in the checkout, so it never takes a lock.
          env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_OPTIONAL_LOCKS: "0" },
          extendEnv: true,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout: decodeOutput(stdout), stderr: decodeOutput(stderr), exitCode };
    }),
  ).pipe(
    Effect.mapError((cause) => new ManifestRepositoryError({ directory, reason: "failed", cause })),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new ManifestRepositoryError({ directory, reason: "timeout" })),
    }),
  );
});

/**
 * Git's own reason from its stderr, such as "Not possible to fast-forward, aborting.", with the
 * indented files that follow a reason ending in a colon.
 */
export function gitFailureReason(stderr: string): string | null {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  const prefixed = lines.findIndex((line) => /^(fatal|error):/.test(line));
  const at = prefixed !== -1 ? prefixed : lines.findIndex((line) => !line.startsWith("hint:"));
  const reason = lines[at];
  if (reason === undefined) return null;
  let text = reason.trim().replace(/^(fatal|error):\s*/, "");
  if (text.endsWith(":")) {
    const details: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line)) break;
      details.push(line.trim());
    }
    if (details.length > 0) text = `${text} ${details.join(", ")}`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const resolveManifestRepository = Effect.fn("AgentctlSandboxes.resolveManifestRepository")(
  function* (directory: string) {
    const result = yield* runGit(directory, ["rev-parse", "--show-toplevel"]);
    return result.exitCode === 0 ? result.stdout : null;
  },
);

/** The folder's own checkout and every checkout holding one of its manifests. */
const folderRepositories = Effect.fn("AgentctlSandboxes.folderRepositories")(function* (
  folder: string,
) {
  const manifests = yield* discoverManifests([folder]);
  const candidates = new Set([folder, ...manifests.map((manifest) => manifest.repository)]);
  const repositories = new Set<string>();
  for (const candidate of candidates) {
    const repository = yield* resolveManifestRepository(candidate).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (repository !== null) repositories.add(repository);
  }
  return { manifests: manifests.length, repositories: [...repositories] };
});

/** Reads `git status --porcelain=v2 --branch`, which reports ahead and behind without fetching. */
export function parseRepositoryStatus(
  path: string,
  porcelain: string,
): Omit<AgentctlRepositoryStatus, "fetchError"> {
  let branch: string | null = null;
  let upstream: string | null = null;
  // Git omits branch.ab when it cannot compare, such as for a deleted upstream or an unborn HEAD.
  let ahead: number | null = null;
  let behind: number | null = null;
  let changes = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line !== "" && !line.startsWith("#")) {
      changes += 1;
    }
  }
  return { path, branch, upstream, changes, ahead, behind };
}

const repositoryStatus = Effect.fn("AgentctlSandboxes.repositoryStatus")(function* (
  repository: string,
  fetchError: string | null,
) {
  const result = yield* runGit(repository, ["status", "--porcelain=v2", "--branch"]);
  if (result.exitCode !== 0) return null;
  return { ...parseRepositoryStatus(repository, result.stdout), fetchError };
});

/** Updates remote-tracking branches, returning why it could not. */
const fetchRepository = (repository: string) =>
  runGit(repository, ["fetch", "--quiet"], FETCH_TIMEOUT).pipe(
    Effect.map((result) =>
      result.exitCode === 0
        ? null
        : (gitFailureReason(result.stderr) ?? "Could not fetch from the remote."),
    ),
    Effect.catch((error) => Effect.succeed(error.message)),
  );

/** Each folder's manifests and the state of its repositories, fetching them first when asked. */
export const describeManifestRoots = Effect.fn("AgentctlSandboxes.describeManifestRoots")(
  function* (folders: ReadonlyArray<string>, options: { readonly fetch: boolean }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const fetched = new Map<string, string | null>();
    return yield* Effect.forEach(folders, (directory) =>
      Effect.gen(function* () {
        const exists = yield* fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return {
            directory,
            exists,
            manifests: 0,
            repositories: [],
          } satisfies AgentctlManifestRoot;
        }
        const found = yield* folderRepositories(directory);
        const repositories: AgentctlRepositoryStatus[] = [];
        for (const repository of found.repositories) {
          // Overlapping folders can share a repository, which is fetched once.
          if (options.fetch && !fetched.has(repository)) {
            fetched.set(repository, yield* fetchRepository(repository));
          }
          const status = yield* repositoryStatus(repository, fetched.get(repository) ?? null).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (status !== null) repositories.push(status);
        }
        return {
          directory,
          exists,
          manifests: found.manifests,
          repositories,
        } satisfies AgentctlManifestRoot;
      }),
    );
  },
);

const revision = (repository: string) =>
  runGit(repository, ["rev-parse", "--verify", "--quiet", "HEAD"]).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)),
  );

const pullRepository = Effect.fn("AgentctlSandboxes.pullRepository")(function* (
  repository: string,
) {
  const before = yield* revision(repository);
  // Override rebase and autostash preferences: this action only fast-forwards.
  const result = yield* runGit(repository, ["pull", "--ff-only", "--no-rebase", "--no-autostash"]);
  if (result.exitCode !== 0) {
    return {
      repository,
      outcome: "failed",
      commits: 0,
      error: gitFailureReason(result.stderr) ?? "Git could not pull this repository.",
    } satisfies AgentctlRepositoryPull;
  }
  const after = yield* revision(repository);
  if (after === null || after === before) {
    return { repository, outcome: "up-to-date", commits: 0, error: null } as const;
  }
  const counted = yield* runGit(repository, [
    "rev-list",
    "--count",
    before === null ? after : `${before}..${after}`,
  ]);
  return {
    repository,
    outcome: "updated",
    commits: counted.exitCode === 0 ? Number(counted.stdout) : 0,
    error: null,
  } satisfies AgentctlRepositoryPull;
});

/**
 * Fast-forwards each repository the folders hold once, including a folder's own checkout. A
 * repository that cannot be pulled is reported without stopping the others.
 */
export const pullManifestRepositories = Effect.fn("AgentctlSandboxes.pullManifestRepositories")(
  function* (folders: ReadonlyArray<string>) {
    const repositories = new Set<string>();
    for (const folder of folders) {
      for (const repository of (yield* folderRepositories(folder)).repositories) {
        repositories.add(repository);
      }
    }
    if (repositories.size === 0) {
      return yield* new ManifestRepositoryError({
        directory: folders.length === 1 ? folders[0]! : "these folders",
        reason: "not-found",
      });
    }
    return yield* Effect.forEach(repositories, (repository) =>
      pullRepository(repository).pipe(
        Effect.catch((error) =>
          Effect.succeed<AgentctlRepositoryPull>({
            repository,
            outcome: "failed",
            commits: 0,
            error: error.message,
          }),
        ),
      ),
    );
  },
);
