// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeAll, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isJjVersionSupported, parseJjVersion } from "../JjAvailability.ts";
import * as JjVcsDriver from "../JjVcsDriver.ts";
import * as VcsProcess from "../VcsProcess.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const probe = NodeChildProcess.spawnSync("jj", ["--version"], { encoding: "utf8" });
const probedVersion = probe.status === 0 ? parseJjVersion(probe.stdout) : null;

const JJ_AVAILABLE: boolean = probedVersion !== null && isJjVersionSupported(probedVersion);

/**
 * Allocate only when tests run, so collection failures and skipped suites cannot leak config dirs.
 * jj 0.46 stores repo config under XDG_CONFIG_HOME (APPDATA on Windows), independently of JJ_CONFIG.
 * The identity also makes fixture commits pushable.
 */
beforeAll(() => {
  if (!JJ_AVAILABLE) return;
  const previousEnv = {
    JJ_CONFIG: process.env.JJ_CONFIG,
    JJ_USER: process.env.JJ_USER,
    JJ_EMAIL: process.env.JJ_EMAIL,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  };
  const configDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jj-config-"));
  const configPath = NodePath.join(configDir, "config.toml");
  NodeFS.writeFileSync(configPath, "");
  process.env.JJ_CONFIG = configPath;
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.APPDATA = configDir;
  process.env.JJ_USER = "T3 Code Test";
  process.env.JJ_EMAIL = "t3code-test@example.com";
  return () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    NodeFS.rmSync(configDir, { recursive: true, force: true });
  };
});

/** `describe` that skips the whole block when jj is absent or below the supported floor. */
export const describeJj = describe.skipIf(!JJ_AVAILABLE);

export class JjTestCommandError extends Schema.TaggedError<JjTestCommandError>()(
  "JjTestCommandError",
  {
    command: Schema.String,
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `jj ${this.command} failed in ${this.cwd}`;
  }
}

/** Runs jj in `cwd` for test fixtures. Fails, never defects. */
export const runJj = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, JjTestCommandError> =>
  Effect.tryPromise({
    try: () => execFileAsync("jj", ["--no-pager", "--color=never", ...args], { cwd }),
    catch: (cause) => new JjTestCommandError({ command: args.join(" "), cwd, cause }),
  }).pipe(Effect.map((result) => result.stdout));

export const createJjRepo = (cwd: string): Effect.Effect<void, JjTestCommandError> =>
  runJj(cwd, ["git", "init", "--colocate"]).pipe(Effect.asVoid);

/** For fixtures a jj repository needs but jj cannot build, such as an external (non-colocated) store. */
export const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, JjTestCommandError> =>
  Effect.tryPromise({
    try: () => execFileAsync("git", [...args], { cwd }),
    catch: (cause) => new JjTestCommandError({ command: `git ${args.join(" ")}`, cwd, cause }),
  }).pipe(Effect.map((result) => result.stdout));

const JjDriverLayer = JjVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

interface SeedJjRepoInput {
  readonly prefix: string;
  readonly seed?: boolean;
  readonly withRemote?: boolean;
  readonly colocated?: boolean;
}

export interface SeededJjRepo {
  /** Scoped temp directory holding the repository, so sibling fixtures cannot collide. */
  readonly base: string;
  readonly root: string;
  readonly remotePath: string;
}

const seedJjRepo = Effect.fnUntraced(function* (input: SeedJjRepoInput) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: input.prefix });
  const base = yield* fileSystem.realPath(created);
  const root = path.join(base, "project");
  const remotePath = path.join(base, "remote.git");
  yield* fileSystem.makeDirectory(root, { recursive: true });

  if (input.colocated === false) {
    const store = path.join(base, "store.git");
    yield* fileSystem.makeDirectory(store, { recursive: true });
    yield* runGit(store, ["init", "--bare", "--initial-branch=main", store]);
    yield* runJj(root, ["git", "init", "--git-repo", store]);
    return { base, root, remotePath } satisfies SeededJjRepo;
  }

  yield* createJjRepo(root);
  if (input.seed === true || input.withRemote === true) {
    yield* fileSystem.writeFileString(path.join(root, "seed.txt"), "seed\n");
    yield* runJj(root, ["commit", "-m", "seed"]);
    yield* runJj(root, ["bookmark", "create", "main", "-r", "@-"]);
  }
  if (input.withRemote === true) {
    yield* fileSystem.makeDirectory(remotePath, { recursive: true });
    yield* runGit(remotePath, ["init", "--bare", "--initial-branch=main", remotePath]);
    yield* runJj(root, ["git", "remote", "add", "origin", remotePath]);
    yield* runJj(root, ["git", "push", "--bookmark", "main", "--remote", "origin"]);
  }
  return { base, root, remotePath } satisfies SeededJjRepo;
});

export interface JjRepoFixture extends SeededJjRepo {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

export const withJjRepo = <A, E>(
  input: SeedJjRepoInput,
  use: (fixture: JjRepoFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const seeded = yield* seedJjRepo(input);
    return yield* use({
      ...seeded,
      driver: yield* JjVcsDriver.JjVcsDriver,
      process: yield* VcsProcess.VcsProcess,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
    });
  }).pipe(Effect.provide(JjDriverLayer));
