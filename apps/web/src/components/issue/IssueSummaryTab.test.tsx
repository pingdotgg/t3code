import type { EnvironmentId, IssueDetail, IssueDetailView } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { IssueSummaryTab } from "./IssueSummaryTab";

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => update }));
vi.mock("../sourceControl/HostMarkdown", () => ({ HostMarkdown: () => null }));
vi.mock("../workItems/WorkItemMatches", () => ({
  useWorkItemMatches: () => ({ pending: null }),
  WorkItemMatchButton: () => null,
  WorkItemMatchRows: () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const coreDetail: IssueDetail = {
  provider: "linear",
  capabilities: {
    comment: false,
    actions: [],
    closeReasons: [],
    create: false,
    issueTemplates: false,
    edit: false,
    labels: false,
    assignees: false,
    listLabelCandidates: false,
    listAssigneeCandidates: false,
    search: true,
    linkedPullRequests: false,
    timelineEvents: false,
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
    create: false,
  },
  projectId: "project-1" as IssueDetail["projectId"],
  projectTitle: "T3 Code",
  workspaceRoot: "/tmp/project",
  repository: "acme/project",
  number: 42,
  title: "A Linear issue",
  body: "",
  url: "https://linear.app/acme/issue/ABC-42",
  author: null,
  state: "open",
  stateReason: null,
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
  linkedPullRequests: [],
};

const detail: IssueDetailView = {
  ...coreDetail,
  body: "Original body",
  comments: [
    {
      id: "comment",
      body: "A comment",
      author: null,
      createdAt: coreDetail.createdAt,
      url: coreDetail.url,
    },
  ],
  commentCount: 1,
  commentsTruncated: false,
  nextCommentsCursor: null,
  events: [],
};
const props: ComponentProps<typeof IssueSummaryTab> = {
  environmentId: "environment-1" as EnvironmentId,
  reference: { projectId: detail.projectId, repository: detail.repository, number: detail.number },
  detail,
  activityPending: false,
  activityError: null,
  editing: true,
  onEditingChange: vi.fn(),
  openPicker: null,
  onOpenPickerChange: vi.fn(),
  onOpenLinkedPullRequest: vi.fn(),
  onOpenAiMatch: vi.fn(),
  onLoadMoreComments: vi.fn(),
  loadingMoreComments: false,
  onRefresh: vi.fn(),
  actionPending: false,
  onCommentAction: async () => ({ commentPosted: false }),
};

it("keeps the description draft during refresh and saves only edited fields", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update.mockResolvedValue({ _tag: "Success" });
  await act(() => {
    renderer = create(<IssueSummaryTab {...props} />);
  });
  const editor = () => renderer.root.findByProps({ "aria-label": "Issue description", rows: 6 });
  await act(() => editor().props.onChange({ target: { value: "My draft" } }));
  const refreshed = { ...detail, title: "Remote title", body: "Remote body" };
  await act(() => renderer.update(<IssueSummaryTab {...props} detail={refreshed} />));
  expect(editor().props.value).toBe("My draft");
  const save = renderer.root
    .findAllByType("button")
    .find((button) => button.children.includes("Save"));
  await act(() => save!.props.onClick());
  expect(update).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: { ...props.reference, body: "My draft" },
  });
  await act(() =>
    renderer.update(<IssueSummaryTab {...props} editing={false} detail={refreshed} />),
  );
  await act(() => renderer.update(<IssueSummaryTab {...props} detail={refreshed} />));
  expect(editor().props.value).toBe("Remote body");
});

it("names the comment order toggle by its visible state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(<IssueSummaryTab {...props} editing={false} />);
  });
  const button = (label: string) =>
    renderer.root.findAllByType("button").find((item) => item.children.includes(label))!;
  expect(button("Newest first").props["aria-label"] ?? "Newest first").toContain("Newest first");
  await act(() => button("Newest first").props.onClick());
  expect(button("Oldest first").props["aria-label"] ?? "Oldest first").toContain("Oldest first");
});
