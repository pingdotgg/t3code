import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Git hooks export repository-specific variables. Do not pass those through to
// commands operating on distilled or a different Alchemy worktree.
const env = { ...process.env };
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")) {
  delete env[name];
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function tryGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function bootstrap(root, previousHead) {
  const checkout = resolve(root, "submodules/distilled");
  // Use the index, just like `git submodule update`, including a staged pin.
  const pin = git(["rev-parse", ":submodules/distilled"], root);
  const commonDir = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    root,
  );
  const gitDir = git(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    root,
  );
  const mainRoot = git(["worktree", "list", "--porcelain", "-z"], root)
    .split("\0")[0]
    .slice("worktree ".length);
  if (previousHead !== undefined) isolateWorktreeConfig(mainRoot);

  if (existsSync(resolve(checkout, ".git"))) {
    if (
      realpathSync(git(["rev-parse", "--show-toplevel"], checkout)) !==
      realpathSync(checkout)
    ) {
      throw new Error(
        `Cannot bootstrap distilled: invalid checkout at ${checkout}`,
      );
    }
    const current = git(["rev-parse", "HEAD"], checkout);
    if (current === pin) return;

    const previousPin = previousHead
      ? tryGit(["rev-parse", `${previousHead}:submodules/distilled`], root)
      : undefined;
    // Only follow an Alchemy checkout when distilled is still at its old pin.
    // Intentional distilled development never moves an existing HEAD.
    if (
      current !== previousPin ||
      tryGit(["symbolic-ref", "--quiet", "HEAD"], checkout) !== undefined ||
      git(["status", "--porcelain"], checkout) !== ""
    ) {
      console.warn(
        `Preserving distilled at ${current}; Alchemy pins ${pin}. To sync explicitly, run: git -C "${root}" submodule update --init --checkout -- submodules/distilled`,
      );
      return;
    }
    ensureCommit(checkout, pin);
    git(["checkout", "--detach", pin], checkout);
    return;
  }

  if (existsSync(checkout) && readdirSync(checkout).length !== 0) {
    throw new Error(
      `Cannot bootstrap distilled: ${checkout} is nonempty but has no .git entry`,
    );
  }

  if (gitDir === commonDir) {
    git(
      [
        "submodule",
        "update",
        "--init",
        "--checkout",
        "--",
        "submodules/distilled",
      ],
      root,
    );
    if (previousHead !== undefined) isolateWorktreeConfig(mainRoot);
    return;
  }

  // Initialize the primary checkout at its own pin first. Every linked checkout
  // then gets an independent detached HEAD backed by that same object database.
  bootstrap(mainRoot);
  isolateWorktreeConfig(mainRoot);
  const mainCheckout = resolve(mainRoot, "submodules/distilled");
  ensureCommit(mainCheckout, pin);
  // The destination was checked above: it is missing or empty. One --force
  // replaces only its stale registration; Git still refuses locked worktrees
  // (overriding a lock would require --force twice). Do not prune other entries.
  git(["worktree", "add", "--force", "--detach", checkout, pin], mainCheckout);
  isolateWorktreeConfig(mainRoot);
  git(["submodule", "init", "--", "submodules/distilled"], root);
}

function isolateWorktreeConfig(mainRoot) {
  const checkout = resolve(mainRoot, "submodules/distilled");
  if (!existsSync(resolve(checkout, ".git"))) return;

  // Resolve the gitfile without opening the repository: its core.worktree may
  // already point at a removed Alchemy worktree, preventing normal Git commands.
  const commonDir = resolve(
    checkout,
    git(["rev-parse", "--resolve-git-dir", ".git"], checkout),
  );
  if (existsSync(resolve(commonDir, "commondir"))) {
    throw new Error(
      "The primary distilled checkout must not be a linked worktree",
    );
  }
  const configs = [[commonDir, checkout]];
  const worktrees = resolve(commonDir, "worktrees");
  if (existsSync(worktrees)) {
    for (const entry of readdirSync(worktrees)) {
      const admin = resolve(worktrees, entry);
      const gitfile = readFileSync(resolve(admin, "gitdir"), "utf8").trim();
      configs.push([admin, dirname(resolve(admin, gitfile))]);
    }
  }
  // Protect every registered worktree, including temporarily missing/locked
  // ones. Submodule sync/update can write core.worktree to the shared config;
  // explicit per-worktree overrides prevent that from redirecting any checkout.
  for (const [admin, path] of configs) {
    git(
      [
        "config",
        "--file",
        resolve(admin, "config.worktree"),
        "core.worktree",
        path,
      ],
      mainRoot,
    );
  }
  const config = resolve(commonDir, "config");
  git(
    ["config", "--file", config, "extensions.worktreeConfig", "true"],
    mainRoot,
  );
  // New worktrees must not inherit a path before their override is installed.
  if (
    tryGit(["config", "--file", config, "--get", "core.worktree"], mainRoot) !==
    undefined
  ) {
    git(["config", "--file", config, "--unset-all", "core.worktree"], mainRoot);
  }
}

function ensureCommit(checkout, pin) {
  if (tryGit(["cat-file", "-e", `${pin}^{commit}`], checkout) === undefined) {
    // Never replace an unavailable pin with a branch tip.
    git(["fetch", "origin", pin], checkout);
    git(["cat-file", "-e", `${pin}^{commit}`], checkout);
  }
}

// Run only for post-checkout branch/worktree checkouts, not file checkouts.
// Hook arguments are old HEAD, new HEAD, and the branch-checkout flag.
if (import.meta.main && process.argv[4] === "1") {
  bootstrap(
    resolve(import.meta.dirname, ".."),
    process.argv[2],
  );
}
