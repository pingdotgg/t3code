import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Git hooks export repository-specific variables. Do not pass those through to
// commands operating on distilled or a different Alchemy worktree.
const env = { ...process.env };
for (const name of (await run("git", ["rev-parse", "--local-env-vars"], {})).stdout
  .trim()
  .split("\n")) {
  delete env[name];
}

// Resolves with the exit status and output; rejects only when the command
// cannot start.
function run(command, args, { cwd, input, stderr = "pipe" } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", stderr] });
    const stdout = [];
    const errors = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => errors.push(chunk));
    child.on("error", fail);
    child.on("close", (status) =>
      done({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8"),
      }),
    );
    child.stdin.end(input);
  });
}

async function git(args, cwd, input) {
  const result = await run("git", args, { cwd, input, stderr: "inherit" });
  if (result.status !== 0) throw new Error(`Command failed: git ${args.join(" ")}`);
  return result.stdout.trim();
}

// Parallel checkouts (several `git worktree add` at once) run this hook
// concurrently against the same shared config files. Retry briefly when another
// hook holds a lock instead of failing the checkout.
async function gitLocked(args, cwd) {
  for (let attempt = 1; ; attempt++) {
    const result = await run("git", args, { cwd });
    if (result.status === 0) return result.stdout.trim();
    const locked = /could not lock|Unable to create '.*\.lock'/.test(result.stderr);
    if (!locked || attempt === 50) {
      process.stderr.write(result.stderr);
      throw new Error(`Command failed: git ${args.join(" ")}`);
    }
    await sleep(100);
  }
}

// Skip the write, and its lock, when the value is already set.
async function setConfig(file, key, value, cwd) {
  if ((await tryGit(["config", "--file", file, "--get", key], cwd)) === value) return;
  await gitLocked(["config", "--file", file, key, value], cwd);
}

async function tryGit(args, cwd) {
  const result = await run("git", args, { cwd });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

export async function bootstrap(root, previousHead) {
  const checkout = resolve(root, "submodules/distilled");
  // Use the index, just like `git submodule update`, including a staged pin.
  const [pin, commonDir, gitDir, worktrees] = await Promise.all([
    git(["rev-parse", ":submodules/distilled"], root),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root),
    git(["rev-parse", "--path-format=absolute", "--git-dir"], root),
    git(["worktree", "list", "--porcelain", "-z"], root),
  ]);
  const mainRoot = worktrees.split("\0")[0].slice("worktree ".length);
  if (previousHead !== undefined) await isolateWorktreeConfig(mainRoot);

  if (await exists(resolve(checkout, ".git"))) {
    const toplevel = await git(["rev-parse", "--show-toplevel"], checkout);
    if ((await realpath(toplevel)) !== (await realpath(checkout))) {
      throw new Error(`Cannot bootstrap distilled: invalid checkout at ${checkout}`);
    }
    const current = await git(["rev-parse", "HEAD"], checkout);
    if (current === pin) return;

    const previousPin = previousHead
      ? await tryGit(["rev-parse", `${previousHead}:submodules/distilled`], root)
      : undefined;
    // Only follow an Alchemy checkout when distilled is still at its old pin.
    // Intentional distilled development never moves an existing HEAD.
    if (
      current !== previousPin ||
      (await tryGit(["symbolic-ref", "--quiet", "HEAD"], checkout)) !== undefined ||
      (await git(["status", "--porcelain"], checkout)) !== ""
    ) {
      console.warn(
        `Preserving distilled at ${current}; Alchemy pins ${pin}. To sync explicitly, run: git -C "${root}" submodule update --init --checkout -- submodules/distilled`,
      );
      return;
    }
    await ensureCommit(checkout, pin);
    await git(["checkout", "--detach", pin], checkout);
    return;
  }

  if ((await exists(checkout)) && (await readdir(checkout)).length !== 0) {
    throw new Error(`Cannot bootstrap distilled: ${checkout} is nonempty but has no .git entry`);
  }

  if (gitDir === commonDir) {
    await git(["submodule", "update", "--init", "--checkout", "--", "submodules/distilled"], root);
    if (previousHead !== undefined) await isolateWorktreeConfig(mainRoot);
    return;
  }

  // Initialize the primary checkout at its own pin first. Every linked checkout
  // then gets an independent detached HEAD backed by that same object database.
  await bootstrap(mainRoot);
  await isolateWorktreeConfig(mainRoot);
  const mainCheckout = resolve(mainRoot, "submodules/distilled");
  await ensureCommit(mainCheckout, pin);
  // The destination was checked above: it is missing or empty. One --force
  // replaces only its stale registration; Git still refuses locked worktrees
  // (overriding a lock would require --force twice). Do not prune other entries.
  await git(
    ["worktree", "add", "--force", "--detach", "--no-checkout", checkout, pin],
    mainCheckout,
  );
  await isolateWorktreeConfig(mainRoot);
  await populate(mainCheckout, checkout, pin);
  await gitLocked(["submodule", "init", "--", "submodules/distilled"], root);
}

// Errors that mean "this filesystem cannot clone files": fall back to writing them.
const NO_CLONE = new Set(["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL", "ENOSYS"]);

/**
 * Fill a `--no-checkout` distilled worktree with the files at `pin`.
 *
 * A distilled checkout is about 1.1 GB, and every Alchemy worktree gets one.
 * On a copy-on-write filesystem (APFS on macOS, btrfs, XFS) a file can be
 * cloned: the copy shares the original's blocks until one of them changes. So
 * every file whose content at `pin` matches the primary checkout's clean copy
 * is cloned from it, which costs a few megabytes in total; Git writes the rest.
 * On other filesystems the first clone fails and Git writes every file, as a
 * plain `git worktree add` would. Set ALCHEMY_DISTILLED_CLONE=0 to skip cloning.
 */
async function populate(mainCheckout, checkout, pin) {
  if (env.ALCHEMY_DISTILLED_CLONE !== "0") await cloneUnchanged(mainCheckout, checkout, pin);
  await git(["reset", "--quiet", "--mixed", pin], checkout);
  // Hash the cloned files once so they count as clean, then let Git write
  // every file that is still missing or different.
  await tryGit(["update-index", "-q", "--refresh"], checkout);
  const stale = await git(["diff", "--name-only", "-z"], checkout);
  if (stale !== "") {
    await git(
      ["checkout", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"],
      checkout,
      stale,
    );
  }
}

async function cloneUnchanged(mainCheckout, checkout, pin) {
  const [status, staged, tree] = await Promise.all([
    git(["status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames"], mainCheckout),
    git(["ls-files", "--stage", "-z"], mainCheckout),
    git(["ls-tree", "-r", "-z", "--full-tree", pin], checkout),
  ]);
  // The primary checkout's index, minus files with uncommitted changes.
  const dirty = new Set(
    status
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3)),
  );
  const indexed = new Map();
  for (const entry of staged.split("\0")) {
    const [meta, path] = entry.split("\t");
    const [mode, oid, stage] = (meta ?? "").split(" ");
    if (path && stage === "0" && mode !== "120000" && mode !== "160000" && !dirty.has(path)) {
      indexed.set(path, oid);
    }
  }
  const sources = new Map();
  for (const entry of tree.split("\0")) {
    const [meta, path] = entry.split("\t");
    const oid = (meta ?? "").split(" ")[2];
    if (!path || indexed.get(path) !== oid) continue;
    const dir = dirname(resolve(checkout, path));
    if (!sources.has(dir)) sources.set(dir, []);
    sources.get(dir).push(resolve(mainCheckout, path));
  }
  await Promise.all([...sources.keys()].map((dir) => mkdir(dir, { recursive: true })));
  if (process.platform === "darwin") await cloneWithCp(sources);
  else await cloneWithNode(sources);
}

// Run `task` over `items`, at most `limit` at a time.
async function eachLimit(items, limit, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Node's copyFile never clones on macOS: COPYFILE_FICLONE_FORCE fails with
// ENOSYS and COPYFILE_FICLONE silently writes a full copy. `cp -c` calls
// clonefile(2). A distilled checkout spans over a thousand directories, so a
// `cp -c` runs per directory batch, one per core at a time. A failed batch
// leaves files missing, which populate() rewrites.
async function cloneWithCp(sources) {
  const batches = [];
  for (const [dir, files] of sources) {
    for (let i = 0; i < files.length; i += 500) batches.push([...files.slice(i, i + 500), dir]);
  }
  await eachLimit(batches, availableParallelism(), (batch) =>
    run("cp", ["-c", ...batch], { stderr: "ignore" }),
  );
}

async function cloneWithNode(sources) {
  const copies = [];
  for (const [dir, files] of sources) {
    for (const source of files) copies.push([source, resolve(dir, basename(source))]);
  }
  let supported = true;
  await eachLimit(copies, 64, async ([source, target]) => {
    if (!supported) return;
    try {
      await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      await rm(target, { force: true });
      if (!NO_CLONE.has(error.code)) throw error;
      supported = false;
    }
  });
}

async function isolateWorktreeConfig(mainRoot) {
  const checkout = resolve(mainRoot, "submodules/distilled");
  if (!(await exists(resolve(checkout, ".git")))) return;

  // Resolve the gitfile without opening the repository: its core.worktree may
  // already point at a removed Alchemy worktree, preventing normal Git commands.
  const commonDir = resolve(
    checkout,
    await git(["rev-parse", "--resolve-git-dir", ".git"], checkout),
  );
  if (await exists(resolve(commonDir, "commondir"))) {
    throw new Error("The primary distilled checkout must not be a linked worktree");
  }
  const configs = [[commonDir, checkout]];
  const worktrees = resolve(commonDir, "worktrees");
  if (await exists(worktrees)) {
    for (const entry of await readdir(worktrees)) {
      const admin = resolve(worktrees, entry);
      const gitfile = (await readFile(resolve(admin, "gitdir"), "utf8")).trim();
      configs.push([admin, dirname(resolve(admin, gitfile))]);
    }
  }
  // Protect every registered worktree, including temporarily missing/locked
  // ones. Submodule sync/update can write core.worktree to the shared config;
  // explicit per-worktree overrides prevent that from redirecting any checkout.
  await Promise.all(
    configs.map(([admin, path]) =>
      setConfig(resolve(admin, "config.worktree"), "core.worktree", path, mainRoot),
    ),
  );
  const config = resolve(commonDir, "config");
  await setConfig(config, "extensions.worktreeConfig", "true", mainRoot);
  // New worktrees must not inherit a path before their override is installed.
  if (
    (await tryGit(["config", "--file", config, "--get", "core.worktree"], mainRoot)) !== undefined
  ) {
    await gitLocked(["config", "--file", config, "--unset-all", "core.worktree"], mainRoot);
  }
}

async function ensureCommit(checkout, pin) {
  if ((await tryGit(["cat-file", "-e", `${pin}^{commit}`], checkout)) === undefined) {
    // Never replace an unavailable pin with a branch tip.
    await git(["fetch", "origin", pin], checkout);
    await git(["cat-file", "-e", `${pin}^{commit}`], checkout);
  }
}

// Run only for post-checkout branch/worktree checkouts, not file checkouts.
// Hook arguments are old HEAD, new HEAD, and the branch-checkout flag.
if (import.meta.main && process.argv[4] === "1") {
  await bootstrap(resolve(import.meta.dirname, ".."), process.argv[2]);
}
