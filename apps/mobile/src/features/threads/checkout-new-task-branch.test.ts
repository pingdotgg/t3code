import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId, VcsListRefsInput } from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
let directory: string;
let cwd: string;
const git = (...args: string[]) => exec("git", ["-C", cwd, ...args]);
const branch = { name: "feature/a", current: false, isDefault: false, worktreePath: null };
const environmentId = EnvironmentId.make("branch-test-environment");

beforeEach(async () => {
  directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-branch-selection-")),
  );
  cwd = NodePath.join(directory, "project");
  await exec("git", ["init", "-b", "main", cwd]);
  await git("config", "user.name", "Branch test");
  await git("config", "user.email", "branch-test@example.com");
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "main\n");
  await git("add", ".");
  await git("commit", "-m", "main");
  await git("checkout", "-b", branch.name);
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "feature\n");
  await git("commit", "-am", "feature");
  await git("checkout", "main");
});

afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

type CheckoutInput = Parameters<typeof checkoutNewTaskBranch>[0];
const decodeListRefsInput = Schema.decodeUnknownSync(VcsListRefsInput);
const REF_PAGE_SIZE = 2;

const readRefs: CheckoutInput["readRefs"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    const input = decodeListRefsInput(request.input);
    const { stdout: rootPath } = await exec("git", [
      "-C",
      input.cwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    const { stdout: head } = await exec("git", [
      "-C",
      input.cwd,
      "rev-parse",
      "--symbolic-full-name",
      "HEAD",
    ]);
    const { stdout } = await exec("git", [
      "-C",
      input.cwd,
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname:short)%09%(worktreepath)%09%(upstream)",
      "refs/heads",
    ]);
    const refs = stdout
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [name = "", path, upstreamRef] = line.split("\t");
        return {
          name,
          current: head.trim() === `refs/heads/${name}`,
          isDefault: name === "main",
          isRemote: false,
          worktreePath: path || null,
          ...(upstreamRef ? { upstreamRef } : {}),
        };
      })
      .filter((ref) => ref.name.includes(input.query ?? ""));
    const cursor = input.cursor ?? 0;
    return {
      isAtRepositoryRoot: (await NodeFSP.realpath(input.cwd)) === rootPath.trim(),
      refs: refs.slice(cursor, cursor + REF_PAGE_SIZE),
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: cursor + REF_PAGE_SIZE < refs.length ? cursor + REF_PAGE_SIZE : null,
      totalCount: refs.length,
    };
  });

const refuseSwitch: CheckoutInput["switchRef"] = () => {
  throw new Error("An occupied branch must not trigger checkout");
};

function selectBranch(switchRef: CheckoutInput["switchRef"]) {
  return checkoutNewTaskBranch({
    branch,
    project: { environmentId, workspaceRoot: cwd },
    workspaceMode: "local",
    readRefs,
    switchRef,
  });
}

const switchRef: CheckoutInput["switchRef"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    await exec("git", ["-C", request.input.cwd, "checkout", request.input.refName]);
    const { stdout } = await exec("git", ["-C", request.input.cwd, "branch", "--show-current"]);
    return { refName: stdout.trim() || null };
  });

async function addRemote(remoteName: string, sourceRef = branch.name) {
  const remotePath = NodePath.join(directory, `${remoteName.replaceAll("/", "-")}.git`);
  await exec("git", ["init", "--bare", remotePath]);
  await git("remote", "add", remoteName, remotePath);
  await git("push", remoteName, `${sourceRef}:refs/heads/${branch.name}`);
  const { stdout } = await git(
    "rev-parse",
    "--verify",
    "--symbolic-full-name",
    `refs/remotes/${remoteName}/${branch.name}`,
  );
  return {
    ...branch,
    name: stdout.trim().replace("refs/remotes/", ""),
    isRemote: true,
    remoteName,
  };
}

describe("new-task branch checkout", () => {
  it("switches to a free branch and clears its historical worktree path", async () => {
    const previousWorktree = NodePath.join(directory, "previous-worktree");
    await git("worktree", "add", previousWorktree, branch.name);
    await exec("git", ["-C", previousWorktree, "checkout", "-b", "other-branch"]);
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath: previousWorktree },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Checkout failed");
    expect(result.value.name).toBe("feature/a");
    expect(result.value.current).toBe(true);
    expect(result.value.worktreePath).toBeNull();
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe("feature\n");
  });

  it("does not release the selection while checkout is still pending", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let completed = false;
    const selection = selectBranch(async (request) => {
      entered.resolve();
      await release.promise;
      return switchRef(request);
    }).then((result) => {
      completed = true;
      return result;
    });
    await entered.promise;
    expect(completed).toBe(false);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    release.resolve();
    expect((await selection)._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
  });

  it("returns checkout failure without selecting the branch or losing dirty files", async () => {
    await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "unsaved local changes\n");
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected checkout to fail");
    expect(String(squashAtomCommandFailure(result))).toContain("would be overwritten");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe(
      "unsaved local changes\n",
    );
  });

  it("reuses an existing worktree without switching the project checkout", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: () => {
        throw new Error("Existing worktrees must not switch the project checkout");
      },
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Worktree selection failed");
    expect(result.value.worktreePath).toBe(worktreePath);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
      "feature\n",
    );
  });

  it("reuses an occupied picker worktree when the project root is a symlink", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, branch.name);
    const workspaceRoot = NodePath.join(directory, "project-alias");
    await NodeFSP.symlink(cwd, workspaceRoot, "junction");

    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });

    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(workspaceRoot, "file.txt"), "utf8")).toBe("main\n");
    expect(
      (await exec("git", ["-C", worktreePath, "branch", "--show-current"])).stdout.trim(),
    ).toBe(branch.name);
    expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
      "feature\n",
    );
    expect(
      result._tag,
      result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : undefined,
    ).toBe("Success");
    if (result._tag !== "Success") throw new Error("Symlink-root worktree selection failed");
    expect(result.value.worktreePath).toBe(worktreePath);
  });

  it("resolves historical branch metadata to its worktree beyond a long query's first page", async () => {
    const name = `feature/${"a".repeat(120)}/${"b".repeat(150)}`;
    await git("branch", "-m", branch.name, name);
    await git("branch", `a-${name}`);
    await git("branch", `b-${name}`);
    await git("worktree", "add", NodePath.join(directory, "decoy"), `a-${name}`);
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, name);

    const result = await checkoutNewTaskBranch({
      branch: { ...branch, name },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Historical branch selection failed");
    expect(result.value).toMatchObject({
      name,
      worktreePath,
    });
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe("main\n");
  });

  it("resolves a non-origin remote to the right worktree when the remote name contains slashes", async () => {
    const remoteBranch = await addRemote("team/upstream");
    await git("branch", "--set-upstream-to", remoteBranch.name, branch.name);
    await git("branch", "upstream/feature/a");
    await git("worktree", "add", NodePath.join(directory, "decoy"), "upstream/feature/a");
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, branch.name);

    const result = await checkoutNewTaskBranch({
      branch: remoteBranch,
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Remote branch selection failed");
    expect(result.value).toMatchObject({
      name: branch.name,
      isRemote: false,
      worktreePath,
    });
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("switches to the selected remote instead of reusing a worktree tracking another remote", async () => {
    const originBranch = await addRemote("origin");
    await git("branch", "--set-upstream-to", originBranch.name, branch.name);
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, branch.name);
    await git("checkout", "-b", "upstream-source");
    await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "upstream feature\n");
    await git("commit", "-am", "divergent upstream feature");
    const remoteBranch = await addRemote("team/upstream", "HEAD");
    const selectedCommit = (await git("rev-parse", remoteBranch.name)).stdout.trim();
    expect((await git("rev-parse", originBranch.name)).stdout.trim()).not.toBe(selectedCommit);
    await git("checkout", "main");

    const result = await checkoutNewTaskBranch({
      branch: remoteBranch,
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef,
    });

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Remote checkout failed");
    expect(result.value.worktreePath).toBeNull();
    expect((await git("rev-parse", "HEAD")).stdout.trim()).toBe(selectedCommit);
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe(
      "upstream feature\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
      "feature\n",
    );
  });

  it.each([
    { source: "historical", nested: true },
    { source: "picker", nested: false },
  ])(
    "rejects $source worktree reuse when project root is unsafe (nested: $nested)",
    async ({ source, nested }) => {
      const projectRoot = cwd;
      const worktreePath = NodePath.join(directory, "worktree");
      await git("worktree", "add", worktreePath, branch.name);
      if (nested) {
        cwd = NodePath.join(projectRoot, "packages", "app");
        await NodeFSP.mkdir(cwd, { recursive: true });
      }
      let checkoutAttempted = false;

      const result = await checkoutNewTaskBranch({
        branch: { ...branch, worktreePath: source === "picker" ? worktreePath : null },
        project: { environmentId, workspaceRoot: cwd },
        workspaceMode: "local",
        readRefs: async (request) => {
          const result = await readRefs(request);
          if (!nested && result._tag === "Success") {
            // Older servers cannot prove whether this project is at the repository root.
            const { isAtRepositoryRoot: _isAtRepositoryRoot, ...value } = result.value;
            return { ...result, value };
          }
          return result;
        },
        switchRef: (request) => {
          checkoutAttempted = true;
          return refuseSwitch(request);
        },
      });

      expect(checkoutAttempted).toBe(false);
      expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
      expect(await NodeFSP.readFile(NodePath.join(projectRoot, "file.txt"), "utf8")).toBe("main\n");
      expect(
        (await exec("git", ["-C", worktreePath, "branch", "--show-current"])).stdout.trim(),
      ).toBe(branch.name);
      expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
        "feature\n",
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected unsafe worktree reuse to fail");
      if (nested) {
        expect(String(squashAtomCommandFailure(result))).toMatch(/subdirectory/i);
      }
    },
  );

  it("keeps a nested project's cwd when historical metadata names the already-current branch", async () => {
    await git("checkout", branch.name);
    cwd = NodePath.join(cwd, "packages", "app");
    await NodeFSP.mkdir(cwd, { recursive: true });

    const result = await selectBranch(refuseSwitch);

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Current branch selection failed");
    expect(result.value).toMatchObject({
      name: branch.name,
      current: true,
      worktreePath: null,
    });
    expect((await git("branch", "--show-current")).stdout.trim()).toBe(branch.name);
  });
});
