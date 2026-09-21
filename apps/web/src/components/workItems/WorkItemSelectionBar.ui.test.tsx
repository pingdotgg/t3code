import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useWorkItemSelection, type SelectedWorkItem } from "~/workItemSelection";

const { newThread, setPrompt, generateTask } = vi.hoisted(() => ({
  newThread: vi.fn(),
  setPrompt: vi.fn(),
  generateTask: vi.fn(),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => newThread }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => generateTask }));
vi.mock("~/state/workItems", () => ({ generateWorkItemTask: "generateWorkItemTask" }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setPrompt }) },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "div",
  TooltipTrigger: "div",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { WorkItemSelectionBarHost } from "./WorkItemSelectionBar";

const issue: SelectedWorkItem = {
  kind: "issue",
  provider: "github",
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
  repository: "acme/app",
  number: 12,
  title: "Fix session refresh",
  url: "https://github.com/acme/app/issues/12",
};
const pullRequest: SelectedWorkItem = {
  ...issue,
  kind: "pull-request",
  number: 13,
  title: "Keep the fix covered",
  url: "https://github.com/acme/app/pull/13",
};

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useWorkItemSelection.setState({ items: [], mode: "compound", selecting: false });
  newThread.mockReset();
  setPrompt.mockReset();
  generateTask.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  useWorkItemSelection.getState().clear();
  vi.unstubAllGlobals();
});

it("shows task shape only for multiple selected items", async () => {
  await act(() => {
    renderer = create(<WorkItemSelectionBarHost />);
    useWorkItemSelection.setState({ items: [issue] });
  });
  expect(renderer.root.findAllByProps({ "aria-label": "Task shape" })).toHaveLength(0);

  await act(() => useWorkItemSelection.setState({ items: [issue, pullRequest] }));
  expect(renderer.root.findAllByProps({ "aria-label": "Task shape" })).toHaveLength(1);
});

it("creates a worktree thread and inserts the complete source prompt without generation", async () => {
  newThread.mockResolvedValue({ draftId: "draft-1" });
  await act(() => {
    renderer = create(<WorkItemSelectionBarHost />);
    useWorkItemSelection.setState({ items: [issue, pullRequest], mode: "subtasks" });
  });

  const createTask = renderer.root
    .findAllByType("button")
    .find((button) => button.children.includes("Create task"));
  expect(createTask).toBeDefined();
  await act(async () => createTask!.props.onClick());

  expect(newThread).toHaveBeenCalledExactlyOnceWith(
    { environmentId: issue.environmentId, projectId: issue.projectId },
    { envMode: "worktree", branch: null, worktreePath: null },
  );
  expect(setPrompt).toHaveBeenCalledOnce();
  expect(generateTask).not.toHaveBeenCalled();
  const [draftId, prompt] = setPrompt.mock.calls[0]!;
  expect(draftId).toBe("draft-1");
  expect(prompt).toContain("subtasks under one parent task");
  expect(prompt).toContain("Fetch their details and discussions first");
  expect(prompt).toContain("link_issue");
  expect(
    prompt
      .split("\n")
      .slice(-2)
      .map((line: string) => JSON.parse(line)),
  ).toEqual([
    {
      kind: issue.kind,
      provider: issue.provider,
      repository: issue.repository,
      number: issue.number,
      title: issue.title,
      url: issue.url,
    },
    {
      kind: pullRequest.kind,
      provider: pullRequest.provider,
      repository: pullRequest.repository,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
    },
  ]);
  expect(useWorkItemSelection.getState().items).toEqual([]);
});
