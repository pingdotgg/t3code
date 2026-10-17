import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId } from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
let directory: string;
let cwd: string;
const git = (...args: string[]) => exec("git", ["-C", cwd, ...args]);
const branch = { name: "feature/a", current: false, isDefault: false, worktreePath: null };
const environmentId = EnvironmentId.make("branch-test-environment");

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-branch-selection-"));
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

const REF_PAGE_SIZE = 2;

// Mirrors the server's local ref listing: a branch's worktree comes from
// `git worktree list`, and `current` means the queried checkout holds it.
const readRefs: CheckoutInput["readRefs"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    const { stdout: worktrees } = await exec("git", [
      "-C",
      request.input.cwd,
      "worktree",
      "list",
      "--porcelain",
    ]);
    const worktreeByBranch = new Map<string, string>();
    let path: string | null = null;
    for (const line of worktrees.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line.startsWith("branch refs/heads/") && path) {
        worktreeByBranch.set(line.slice("branch refs/heads/".length), path);
      }
    }
    const { stdout: names } = await exec("git", [
      "-C",
      request.input.cwd,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    const refs = names
      .split("\n")
      .filter((name) => name.length > 0 && name.includes(request.input.query ?? ""))
      .map((name) => {
        const worktreePath = worktreeByBranch.get(name) ?? null;
        return {
          name,
          current: worktreePath === request.input.cwd,
          isDefault: false,
          isRemote: false,
          worktreePath,
        };
      });
    const cursor = request.input.cursor ?? 0;
    const page = refs.slice(cursor, cursor + REF_PAGE_SIZE);
    return {
      refs: page,
      isRepo: true,
      hasPrimaryRemote: false,
      nextCursor: cursor + page.length < refs.length ? cursor + page.length : null,
      totalCount: refs.length,
    };
  });

function selectBranch(switchRef: CheckoutInput["switchRef"]) {
  return checkoutNewTaskBranch({
    branch,
    project: { environmentId, workspaceRoot: cwd },
    workspaceMode: "local",
    readRefs,
    switchRef,
  });
}

const refuseSwitch: CheckoutInput["switchRef"] = () => {
  throw new Error("A branch held by a worktree must not switch the project checkout");
};

const switchRef: CheckoutInput["switchRef"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    await exec("git", ["-C", request.input.cwd, "checkout", request.input.refName]);
    const { stdout } = await exec("git", ["-C", request.input.cwd, "branch", "--show-current"]);
    return { refName: stdout.trim() };
  });

describe("new-task branch checkout", () => {
  it("switches main to the older thread's feature branch before returning a selection", async () => {
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Checkout failed");
    expect(result.value.name).toBe("feature/a");
    expect(result.value.current).toBe(true);
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

  it("fails when the source project is unavailable instead of releasing a composer selection", async () => {
    const result = await checkoutNewTaskBranch({
      branch,
      project: null,
      workspaceMode: "local",
      readRefs,
      switchRef: () => {
        throw new Error("An unavailable project must not run checkout");
      },
    });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected an unavailable-project failure");
    expect(String(squashAtomCommandFailure(result))).toContain("selected project is unavailable");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("reuses an existing worktree without switching the project checkout", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Worktree selection failed");
    expect(result.value.worktreePath).toBe(worktreePath);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
      "feature\n",
    );
  });

  it("reuses the worktree a branch moved into after the thread remembered it", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await selectBranch(refuseSwitch);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Worktree selection failed");
    expect(result.value.name).toBe("feature/a");
    expect(result.value.worktreePath).toBe(await NodeFSP.realpath(worktreePath));
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("resolves a remote ref to the worktree holding its local branch", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, name: "upstream/feature/a", isRemote: true, remoteName: "upstream" },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Remote worktree selection failed");
    expect(result.value).toMatchObject({ name: "feature/a", isRemote: false });
    expect(result.value.worktreePath).toBe(await NodeFSP.realpath(worktreePath));
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("skips checkout when the project checkout already holds the branch", async () => {
    await git("checkout", "feature/a");
    const result = await selectBranch(refuseSwitch);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Current branch selection failed");
    expect(result.value.current).toBe(true);
  });

  it("finds the branch past the first page of similarly named branches", async () => {
    for (const name of ["a-feature/a", "b-feature/a", "c-feature/a"]) await git("branch", name);
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await selectBranch(refuseSwitch);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Paged worktree selection failed");
    expect(result.value.worktreePath).toBe(await NodeFSP.realpath(worktreePath));
  });

  it("looks up a branch whose name is longer than the ref query limit", async () => {
    const longName = `feature/${"a".repeat(120)}/${"b".repeat(150)}`;
    await git("branch", longName);
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, longName);
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, name: longName },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs: (request) => {
        expect(request.input.query?.length).toBeLessThanOrEqual(256);
        return readRefs(request);
      },
      switchRef: refuseSwitch,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Long branch selection failed");
    expect(result.value.worktreePath).toBe(await NodeFSP.realpath(worktreePath));
  });

  it("strips a remote name that contains a slash before looking up the branch", async () => {
    await git("branch", "upstream/feature/a");
    const decoyPath = NodePath.join(directory, "decoy");
    await git("worktree", "add", decoyPath, "upstream/feature/a");
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await checkoutNewTaskBranch({
      branch: {
        ...branch,
        name: "team/upstream/feature/a",
        isRemote: true,
        remoteName: "team/upstream",
      },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      readRefs,
      switchRef: refuseSwitch,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Remote worktree selection failed");
    expect(result.value.name).toBe("feature/a");
    expect(result.value.worktreePath).toBe(await NodeFSP.realpath(worktreePath));
  });
});
