import { EnvironmentId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitActions } from "./useGitActions";

const fixture = vi.hoisted(() => ({
  status: null as VcsStatusResult | null,
  run: vi.fn(),
  addToast: vi.fn(() => "toast"),
  updateToast: vi.fn(),
  closeToast: vi.fn(),
  command: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: fixture.status, error: null }),
}));
vi.mock("../state/entities", () => ({ useThread: () => ({ branch: fixture.status?.refName }) }));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => fixture.command }));
vi.mock("../lib/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: fixture.run }),
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({ run: fixture.command }),
  useVcsPullAction: () => ({ run: fixture.command }),
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: fixture.addToast, update: fixture.updateToast, close: fixture.closeToast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => fixture.command }));
vi.mock("../browser/useOpenLink", () => ({ useOpenLink: () => fixture.command }));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => fixture.command }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ getDraftThreadByRef: () => null, setDraftThreadContext: fixture.command }),
}));

let renderer: ReactTestRenderer;
let actions: ReturnType<typeof useGitActions>;
const threadRef = { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") };
function Probe() {
  const value = useGitActions({
    gitCwd: "/tmp/project",
    activeThreadRef: threadRef,
    onOpenPublish: fixture.command,
  });
  useLayoutEffect(() => {
    actions = value;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
  fixture.status = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    pr: null,
  };
  fixture.run.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      branch: { status: "skipped" },
      toast: {
        title: "Committed",
        description: "Ready to push",
        cta: { kind: "run_action", label: "Push", action: { kind: "push" } },
      },
    },
  });
  fixture.updateToast.mockClear();
  await act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("git result toast actions", () => {
  it("uses current branch state before retrying a retained toast action", async () => {
    await act(() => actions.runGitActionWithToast({ action: "commit" }));
    const retry = fixture.updateToast.mock.calls.at(-1)?.[1].actionProps.onClick;
    expect(retry).toBeTypeOf("function");
    fixture.status = { ...fixture.status!, refName: "main", isDefaultRef: true };
    await act(() => renderer.update(<Probe />));
    await act(() => retry());
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(actions.pendingDefaultBranchAction).toMatchObject({
      action: "push",
      branchName: "main",
    });
  });

  it("does not run a retained action after its owning hook unmounts", async () => {
    await act(() => actions.runGitActionWithToast({ action: "commit" }));
    const retry = fixture.updateToast.mock.calls.at(-1)?.[1].actionProps.onClick;
    await act(() => renderer.unmount());
    await act(() => retry());
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
});
