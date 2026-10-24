import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";

const fixture = JSON.parse(
  await NodeFSP.readFile(new URL("./fixture.json", import.meta.url), "utf8"),
);
const action = process.argv[2] ?? "manifest";
const exists = async (path) =>
  NodeFSP.lstat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
if (!["manifest", "prepare", "missing", "restore"].includes(action)) {
  throw new Error("Usage: node seed.mjs [manifest|prepare|missing|restore]");
}
if (action !== "manifest") {
  const original = await exists(fixture.projectPath);
  const renamed = await exists(fixture.renamedPath);
  if (original && renamed)
    throw new Error("Both fixture paths exist; refusing to overwrite either.");
  if (action === "missing" && original)
    await NodeFSP.rename(fixture.projectPath, fixture.renamedPath);
  if (action !== "missing" && renamed)
    await NodeFSP.rename(fixture.renamedPath, fixture.projectPath);
  if (action === "prepare") {
    await NodeFSP.mkdir(fixture.projectPath, { recursive: true });
    if (!(await exists(`${fixture.projectPath}/.git`))) {
      NodeChildProcess.execFileSync("git", ["init", "--quiet", "--initial-branch=fixture"], {
        cwd: fixture.projectPath,
      });
    }
    await NodeFSP.writeFile(
      `${fixture.projectPath}/fixture.txt`,
      "Disposable missing-terminal-folder fixture.\n",
    );
    NodeChildProcess.execFileSync("git", ["add", "fixture.txt"], { cwd: fixture.projectPath });
    const dirty = NodeChildProcess.execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: fixture.projectPath,
      encoding: "utf8",
    });
    if (dirty.trim()) {
      NodeChildProcess.execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        {
          cwd: fixture.projectPath,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: fixture.wallClock,
            GIT_COMMITTER_DATE: fixture.wallClock,
          },
        },
      );
    }
    await NodeFSP.mkdir(`${fixture.root}/worktrees`, { recursive: true });
    if (!(await exists(fixture.longPath))) {
      NodeChildProcess.execFileSync(
        "git",
        ["worktree", "add", "--quiet", "--detach", fixture.longPath],
        {
          cwd: fixture.projectPath,
        },
      );
    }
  }
}
console.log(
  JSON.stringify(
    {
      ...fixture,
      action,
      projectExists: await exists(fixture.projectPath),
      renamedExists: await exists(fixture.renamedPath),
    },
    null,
    2,
  ),
);
