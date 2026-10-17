import { EnvironmentId, type PullRequestCheck } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  extraStatus: null as PullRequestCheck["status"] | null,
  perform: vi.fn(),
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useServerConfigs: (() => new Map()) as never,
}));
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
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
      checks: [state.status, ...(state.extraStatus ? [state.extraStatus] : [])].map((status) => ({
        name: `CI-${status}`,
        status,
        description: null,
        url: null,
      })),
      capabilities: { actions: ["merge"], mergeMethods: ["merge"] },
      viewerPermissions: { actions: ["merge"] },
      mergeCapabilities: { merge: true, squash: false, rebase: false },
    },
    dataUpdatedAt: 1,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../pullRequest/usePullRequestActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePullRequestActionRunner: () => ({ actionPending: false, perform: state.perform }),
  usePullRequestHandoffs: () => ({ handoff: null, startAsk: vi.fn(), startHandoff: vi.fn() }),
}));

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  state.status = "success";
  state.extraStatus = null;
});

it("requires a new merge click after passing checks become pending and pass again", () => {
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
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Merge")!
        .click();
    });
  const dialogs = () => [...document.querySelectorAll('[role="alertdialog"]')];

  act(() => root.render(render()));
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  act(() => {
    state.status = "pending";
    root.render(render());
  });
  expect(dialogs()).toHaveLength(0);
  act(() => {
    state.status = "success";
    root.render(render());
  });
  expect(dialogs()).toHaveLength(0);
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  expect(state.perform).not.toHaveBeenCalled();
});

it.each<[PullRequestCheck["status"], PullRequestCheck["status"], string]>([
  ["success", "skipped", ""],
  ["failure", "cancelled", ""],
  ["success", "action-required", ""],
  ["success", "pending", "1/2"],
  ["failure", "pending", "1/2"],
])("shows a count only while checks run (%s, %s)", (status, extraStatus, count) => {
  state.status = status;
  state.extraStatus = extraStatus;
  act(() => {
    root.render(
      <ThreadDetailsPrRow
        environmentId={EnvironmentId.make("environment")}
        pr={null}
        number={1}
        status={null}
        project={null}
        label="Test PR"
        openAriaLabel="Open PR"
        onOpen={vi.fn()}
      />,
    );
  });
  const counts = [...container.querySelectorAll("*")]
    .map((element) => element.textContent?.trim() ?? "")
    .filter((value) => /^\d+\/\d+$/.test(value));
  expect(new Set(counts)).toEqual(new Set(count ? [count] : []));
});
