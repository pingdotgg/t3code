import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { visitElements } from "~/test/reactElementTree";
import { IssueCreateDialog } from "./IssueCreateDialog";
import { DialogPopup } from "../ui/dialog";

const createIssue = vi.hoisted(() => vi.fn());
let pending = false;
let blankIssuesEnabled = true;
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("~/state/entities", () => ({
  useProjects: () => [{ id: "p1", repositoryIdentity: { displayName: "acme/web" } }],
}));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { templates: () => "templates", create: "create" },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: pending ? null : { templates: [], contactLinks: [], blankIssuesEnabled },
    error: null,
    isPending: pending,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => createIssue }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function renderDialog() {
  hooks.beginRender();
  return IssueCreateDialog({
    open: true,
    onOpenChange: vi.fn(),
    environmentId: "local" as EnvironmentId,
    projects: [{ id: "p1" as ProjectId, title: "Web", workspaceRoot: "/w" }],
    projectId: "p1" as ProjectId,
    onCreated: vi.fn(),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  pending = false;
  blankIssuesEnabled = true;
});

it("blocks the submit shortcut while templates load and when blank issues are disabled", async () => {
  hooks.reset();
  vi.stubGlobal("navigator", { platform: "Linux" });
  createIssue.mockResolvedValue({
    _tag: "Success",
    value: { number: 1, url: "https://github.com/acme/web/issues/1" },
  });
  const title = visitElements(renderDialog(), (element) => element.props.id === "issue-title")!;
  (title.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "Test issue" },
  });
  const submit = () => {
    const popup = visitElements(renderDialog(), (element) => element.type === DialogPopup)!;
    (popup.props.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      ctrlKey: true,
      preventDefault: vi.fn(),
    });
  };
  pending = true;
  submit();
  expect(createIssue).not.toHaveBeenCalled();
  pending = false;
  blankIssuesEnabled = false;
  submit();
  expect(createIssue).not.toHaveBeenCalled();
  blankIssuesEnabled = true;
  submit();
  expect(createIssue).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ title: "Test issue", repository: "acme/web" }),
    }),
  );
  await createIssue.mock.results[0]!.value;
});
