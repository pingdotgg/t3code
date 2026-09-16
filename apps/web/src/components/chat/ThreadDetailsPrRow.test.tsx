import { EnvironmentId, type PullRequestCheck } from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  perform: vi.fn(),
}));

vi.mock("~/state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: {} }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      number: 1,
      title: "Test PR",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      headBranch: "feature",
      baseBranch: "main",
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      checks: [{ name: "CI", status: state.status, description: null, url: null }],
      capabilities: { actions: ["merge"], mergeMethods: ["merge"] },
      viewerPermissions: { actions: ["merge"] },
      mergeCapabilities: { merge: true, squash: false, rebase: false },
    },
    dataUpdatedAt: 1,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../pullRequest/usePullRequestActions", () => ({
  usePullRequestActionRunner: () => ({ actionPending: false, perform: state.perform }),
  usePullRequestHandoffs: () => ({ handoff: null, startHandoff: vi.fn() }),
}));
vi.mock("../pullRequest/PullRequestChecksPopover", () => ({
  PullRequestChecksPopover: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, undefined, children),
  TooltipPopup: () => null,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => children,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
  AlertDialogClose: () => null,
}));

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("requires a new merge click after passing checks become pending and pass again", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = () => (
    <ThreadDetailsPrRow
      environmentId={EnvironmentId.make("environment")}
      pr={null}
      number={1}
      status={null}
      project={null}
      label="Test PR"
      openAriaLabel="Open PR"
      onOpen={vi.fn()}
    />
  );
  const clickMerge = () =>
    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Merge"))!
        .props.onClick();
    });
  const dialogs = () => renderer.root.findAllByProps({ role: "alertdialog" });

  act(() => {
    renderer = create(render());
  });
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  act(() => {
    state.status = "pending";
    renderer.update(render());
  });
  expect(dialogs()).toHaveLength(0);
  act(() => {
    state.status = "success";
    renderer.update(render());
  });
  expect(dialogs()).toHaveLength(0);
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  expect(state.perform).not.toHaveBeenCalled();
});
