import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId, VcsListRefsInput } from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { GIT_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";

import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

const picker = vi.hoisted(() => {
  const branch: { name: string; current: boolean; worktreePath: string | null } = {
    name: "feature/a",
    current: false,
    worktreePath: null,
  };
  const additionalBranches: Array<typeof branch> = [];
  return {
    supported: true,
    workspaceMode: "local",
    branch,
    additionalBranches,
    unsupportedWorkspace: null as string | null,
    readRefs: vi.fn(),
    switchRef: vi.fn(),
    selectBranch: vi.fn(),
    goBack: vi.fn(),
    statusProbes: vi.fn(),
  };
});
vi.mock("../../components/ui/Toolbar", () => ({ Toolbar: () => null }));
vi.mock("../../components/ui/SearchField", () => ({ SearchField: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) =>
    createElement("button", { disabled: props.disabled, onClick: props.onPress }, props.label),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/NavigationRow", () => ({
  NavigationRow: (props: { title: string; disabled?: boolean; onPress: () => void }) =>
    createElement("button", { disabled: props.disabled, onClick: props.onPress }, props.title),
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: "div" }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../native/use-native-mail-search-toolbar", () => ({
  useNativeMailSearchToolbar: () => false,
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  createNativeMailSearchToolbarItem: () => null,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET: 0,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Pressable: "button",
  ScrollView: "div",
  TextInput: () => null,
  View: "div",
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: picker.goBack,
    isFocused: () => true,
    addListener: () => () => {},
  }),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: { data: readonly unknown[]; renderItem: (input: unknown) => unknown }) =>
    props.data.map((item, index) => props.renderItem({ item, index })),
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) => (atom === "readRefs" ? picker.readRefs : picker.switchRef),
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { readRefs: "readRefs", switchRef: "switchRef" },
  useVcsTerminology: () => GIT_VCS_TERMINOLOGY,
  useVcsActionSupport: (_environmentId: unknown, cwd: string | null) => {
    picker.statusProbes(cwd);
    const supported = picker.supported && (cwd === null || cwd !== picker.unsupportedWorkspace);
    return {
      supported,
      unsupportedReason: supported ? null : "This repository is unsupported",
    };
  },
}));
vi.mock("./new-task-flow-provider", () => ({
  branchBadgeLabel: () => null,
  useNewTaskFlow: () => ({
    selectedProject: { environmentId: "branch-test-environment", workspaceRoot: "/repo" },
    workspaceMode: picker.workspaceMode,
    vcsActionsSupported: picker.supported,
    canUseVcsActions: (worktreePath?: string | null) =>
      picker.supported && (worktreePath == null || worktreePath !== picker.unsupportedWorkspace),
    vcsUnsupportedReason: picker.supported ? null : "This repository is unsupported",
    vcsTerminology: GIT_VCS_TERMINOLOGY,
    filteredBranches: [picker.branch, ...picker.additionalBranches],
    availableBranches: [],
    setBranchQuery: () => {},
    selectBranch: picker.selectBranch,
  }),
}));

import { NewTaskBranchPickerRouteScreen } from "./NewTaskContextPickerScreens";

describe("new-task branch picker capability guards", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    picker.supported = true;
    picker.workspaceMode = "local";
    picker.unsupportedWorkspace = null;
    picker.branch = { name: "feature/a", current: false, worktreePath: null };
    picker.additionalBranches = [];
    picker.readRefs.mockReset().mockImplementation(() =>
      settlePromise(async () => ({
        refs: [{ ...picker.branch, isDefault: false }],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 1,
        isAtRepositoryRoot: true,
      })),
    );
    picker.switchRef.mockReset().mockResolvedValue(AsyncResult.success({ refName: "feature/a" }));
    picker.selectBranch.mockClear();
    picker.goBack.mockClear();
    picker.statusProbes.mockClear();
  });

  it("does not add status subscriptions for plain Git branch rows", async () => {
    picker.branch.worktreePath = "/worktrees/feature-a";
    picker.additionalBranches = [
      { name: "feature/b", current: false, worktreePath: "/worktrees/feature-b" },
      { name: "feature/c", current: false, worktreePath: "/worktrees/feature-c" },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(NewTaskBranchPickerRouteScreen)));
      expect(
        Array.from(container.querySelectorAll("button"), (button) => button.textContent),
      ).toEqual(["feature/a", "feature/b", "feature/c"]);
      expect(picker.statusProbes.mock.calls.map(([cwd]) => cwd)).toEqual(["/repo"]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    { mode: "local", current: false, worktreePath: null },
    { mode: "local", current: true, worktreePath: null },
    { mode: "local", current: false, worktreePath: "/existing-worktree" },
    { mode: "worktree", current: false, worktreePath: null },
  ])("keeps supported Git selection behavior for $mode at $worktreePath", async (input) => {
    picker.workspaceMode = input.mode;
    picker.branch = { ...picker.branch, current: input.current, worktreePath: input.worktreePath };
    picker.switchRef.mockImplementation(() =>
      settlePromise(async () => ({ refName: "feature/a" })),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(NewTaskBranchPickerRouteScreen)));
      expect(container.querySelector("button")?.disabled).toBe(false);
      await act(async () => container.querySelector("button")!.click());
      expect(picker.switchRef).toHaveBeenCalledTimes(
        input.mode === "local" && !input.current && input.worktreePath === null ? 1 : 0,
      );
      expect(picker.selectBranch).toHaveBeenCalledOnce();
      expect(picker.goBack).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(["local", "worktree"])(
    "checks an existing workspace only when %s selection will actually reuse it",
    async (mode) => {
      picker.workspaceMode = mode;
      picker.branch = { ...picker.branch, worktreePath: "/existing-worktree" };
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => root.render(createElement(NewTaskBranchPickerRouteScreen)));
        picker.unsupportedWorkspace = "/existing-worktree";
        await act(async () => container.querySelector("button")!.click());
        expect(picker.switchRef).not.toHaveBeenCalled();
        expect(picker.selectBranch).toHaveBeenCalledTimes(mode === "local" ? 0 : 1);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each(["local", "worktree"])(
    "refuses an already-open %s selection after unsupported metadata arrives",
    async (mode) => {
      picker.workspaceMode = mode;
      picker.supported = true;
      picker.switchRef.mockClear();
      picker.selectBranch.mockClear();
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => root.render(createElement(NewTaskBranchPickerRouteScreen)));
        const button = container.querySelector("button");
        expect(button).not.toBeNull();
        picker.supported = false;
        await act(async () => button!.click());
        expect(picker.switchRef).not.toHaveBeenCalled();
        expect(picker.selectBranch).not.toHaveBeenCalled();
        await act(async () => root.render(createElement(NewTaskBranchPickerRouteScreen)));
        expect(container.querySelector("button")?.disabled).toBe(true);
        expect(container.textContent).toContain("This repository is unsupported");
      } finally {
        await act(async () => root.unmount());
        picker.supported = true;
      }
    },
  );
});

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
    { source: "picker", nested: true },
    { source: "historical", nested: false },
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
