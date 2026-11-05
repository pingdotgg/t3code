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
const branch = { name: "feature/a", current: false, isDefault: false };
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
      "--format=%(refname:short)%09%(upstream)",
      "refs/heads",
    ]);
    const refs = stdout
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [name = "", upstreamRef] = line.split("\t");
        return {
          name,
          current: head.trim() === `refs/heads/${name}`,
          isDefault: name === "main",
          isRemote: false,
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

describe("new-task branch checkout", () => {
  it("switches to a free branch", async () => {
    const result = await checkoutNewTaskBranch({
      branch,
      project: { environmentId, workspaceRoot: cwd },
      readRefs,
      switchRef,
    });
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

  it("keeps a nested project's cwd when historical metadata names the already-current branch", async () => {
    await git("checkout", branch.name);
    cwd = NodePath.join(cwd, "packages", "app");
    await NodeFSP.mkdir(cwd, { recursive: true });

    const result = await selectBranch(refuseSwitch);

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Current branch selection failed");
    expect(result.value).toMatchObject({ name: branch.name, current: true });
    expect((await git("branch", "--show-current")).stdout.trim()).toBe(branch.name);
  });
});
