import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestRef,
  type PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { act, cloneElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  run: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  submit: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  toast: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    runHostAction: { permissionAtom: () => "host-action" },
    submitReview: { permissionAtom: () => "submit-review" },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { permissionAtom: () => string }) =>
    command.permissionAtom() === "host-action" ? state.run : state.submit,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: "output",
}));
vi.mock("../ui/menu", () => ({
  Menu: "menu",
  MenuPopup: "div",
  MenuTrigger: "trigger",
  MenuItem: "menuitem",
}));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectTrigger: "button",
  SelectPopup: "div",
  SelectItem: "option",
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ open, children }: { open: boolean; children: ReactNode }) => (
    <div data-composer-open={open}>{children}</div>
  ),
  PopoverTrigger: "trigger",
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTitle: "h2",
  PopoverClose: "close",
}));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("./PullRequestTextarea", () => ({ PullRequestTextarea: "textarea" }));
vi.mock("./PullRequestCommentForm", () => ({ PullRequestCommentForm: () => null }));

import { PullRequestReviewButton } from "./PullRequestReviewButton";
import { Popover } from "../ui/popover";
import { PullRequestComposer } from "./PullRequestComposer";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import {
  pullRequestReviewKey,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

const environmentId = EnvironmentId.make("environment");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  host: "dev.azure.com",
  repository: "review-demo",
  number: 1352,
};
const detail: PullRequestDetailView = {
  ...reference,
  provider: SourceControlProviderKind.make("azure-devops"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  title: "Review this change",
  body: "",
  url: "https://dev.azure.com/org/project/_git/review-demo/pullrequest/1352",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "reviewer",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: true, squash: true, rebase: false },
  capabilities: {
    hostActions: true,
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: {
      inlineComment: true,
      reply: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
    },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
    requestReviewers: false,
  },
};
const comment: PendingReviewComment = {
  id: "pending-1",
  path: "src/example.ts",
  position: { kind: "added", newLine: 5 },
  body: "Please keep this inline comment.",
};
const onActed = vi.fn();
const onReview = vi.fn();
let renderer: ReactTestRenderer;

function renderButton(value = detail, actionPending = false) {
  return (
    <PullRequestReviewButton
      environmentId={environmentId}
      reference={reference}
      detail={value}
      actionPending={actionPending}
      onReview={onReview}
      onActed={onActed}
    />
  );
}
const approve = () =>
  renderer.root.find(
    (node) => node.type === "button" && node.props["aria-label"] === "Approve pull request",
  );
const option = (label: string) =>
  renderer.root.findAllByType("menuitem").find((node) => node.children.includes(label))!;
const submit = () =>
  renderer.root.findAllByType("button").find((node) => node.children.includes("Submit review"))!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.run.mockReset().mockResolvedValue({ _tag: "Success", value: { message: "Vote recorded" } });
  state.submit.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toast.mockReset();
  onActed.mockReset();
  onReview.mockReset();
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("sends one Azure vote for repeated clicks and locks all votes until completion", async () => {
  let complete!: (value: unknown) => void;
  state.run.mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
  act(() => {
    renderer = create(renderButton());
  });
  const click = approve().props.onClick;
  await act(async () => {
    click();
    click();
  });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, action: { type: "vote", vote: "approve" } },
  });
  expect(option("Reject").props.disabled).toBe(true);
  await act(async () => option("Reject").props.onClick());
  expect(state.run).toHaveBeenCalledTimes(1);
  expect(onActed).not.toHaveBeenCalled();
  await act(async () => complete({ _tag: "Success", value: { message: "Vote recorded" } }));
  expect(onActed).toHaveBeenCalledOnce();
  await act(async () => option("Reset feedback").props.onClick());
  expect(state.run).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, action: { type: "vote", vote: "reset" } },
  });
});

it("reports Azure refusal and unlocks the vote for retry", async () => {
  state.run.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Vote refused")),
  });
  act(() => {
    renderer = create(renderButton());
  });
  await act(async () => approve().props.onClick());
  expect(onActed).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  expect(approve().props.disabled).toBe(false);
  await act(async () => approve().props.onClick());
  expect(state.run).toHaveBeenCalledTimes(2);
  expect(onActed).toHaveBeenCalledOnce();
});

it.each([
  { allowed: false, draft: false, denial: undefined, reason: "This connection does not allow" },
  { allowed: true, draft: false, denial: "Branch policy forbids voting.", reason: "Branch policy" },
])("refuses denied Azure votes with an explanation: $reason", async (scenario) => {
  state.allowed = scenario.allowed;
  act(() => {
    renderer = create(
      renderButton({
        ...detail,
        isDraft: scenario.draft,
        viewerPermissions: {
          ...detail.viewerPermissions,
          deniedActions: scenario.denial ? { vote: scenario.denial } : {},
        },
      }),
    );
  });
  expect(approve().props.disabled).toBe(true);
  expect(renderer.root.findAllByType("output")[0]!.children.join("")).toContain(scenario.reason);
  await act(async () => {
    approve().props.onClick();
    option("Reject").props.onClick();
  });
  expect(state.run).not.toHaveBeenCalled();
});

it("refuses another vote while a panel action is pending", async () => {
  act(() => {
    renderer = create(renderButton(detail, true));
  });
  await act(async () => approve().props.onClick());
  expect(state.run).not.toHaveBeenCalled();
});

it.each(["gitlab", "forgejo", "bitbucket", "gitcafe"])(
  "does not expose the review shortcut for %s",
  (provider) => {
    act(() => {
      renderer = create(
        renderButton({ ...detail, provider: SourceControlProviderKind.make(provider) }),
      );
    });
    expect(renderer.toJSON()).toBeNull();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.submit).not.toHaveBeenCalled();
  },
);

it.each(["closed", "merged"] as const)("does not offer voting on a %s pull request", (prState) => {
  act(() => {
    renderer = create(renderButton({ ...detail, state: prState }));
  });
  expect(renderer.toJSON()).toBeNull();
  expect(onReview).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
});

const githubDetail: PullRequestDetailView = {
  ...detail,
  provider: SourceControlProviderKind.make("github"),
  capabilities: { ...detail.capabilities, hostActions: false },
};

it("removes Azure voting in draft mode and restores it after publication", async () => {
  act(() => {
    renderer = create(renderButton({ ...detail, isDraft: true }));
  });
  expect(renderer.toJSON()).toBeNull();
  act(() => renderer.update(renderButton()));
  await act(async () => approve().props.onClick());
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, action: { type: "vote", vote: "approve" } },
  });
  act(() => renderer.update(renderButton({ ...detail, isDraft: true })));
  expect(renderer.toJSON()).toBeNull();
});

it("continues to offer reviews on GitHub drafts", async () => {
  act(() => {
    renderer = create(renderButton({ ...githubDetail, isDraft: true }));
  });
  await act(async () => approve().props.onClick());
  expect(onReview).toHaveBeenCalledExactlyOnceWith("approve");
  expect(state.run).not.toHaveBeenCalled();
});

it("uses the requested GitHub verdict on the form's first mount", async () => {
  function Form() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [pending, setPending] = useState(false);
    return (
      <PullRequestReviewForm
        environmentId={environmentId}
        reference={reference}
        verdicts={githubDetail.capabilities.review.verdicts}
        requestChangesSummaryRequired={false}
        textareaRef={textareaRef}
        pending={pending}
        onPendingChange={setPending}
        onSubmitted={onActed}
        verdictRequest={{ verdict: "approve" }}
      />
    );
  }
  act(() => {
    renderer = create(<Form />);
  });
  expect(submit().props.disabled).toBe(false);
  await act(async () => submit().props.onClick());
  expect(state.submit).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, verdict: "approve", body: "", comments: [] },
  });
});

it("reopens GitHub reviews with the requested verdict and preserves drafts through a failed submission", async () => {
  const key = pullRequestReviewKey(reference);
  usePullRequestReviewStore.getState().addComment(key, comment);
  function Review() {
    const [request, setRequest] = useState<{ verdict?: PullRequestReviewVerdict } | null>(null);
    return (
      <>
        <PullRequestReviewButton
          environmentId={environmentId}
          reference={reference}
          detail={githubDetail}
          actionPending={false}
          onReview={(verdict) => setRequest({ verdict })}
          onActed={onActed}
        />
        <PullRequestComposer
          environmentId={environmentId}
          reference={reference}
          detail={githubDetail}
          actionPending={false}
          openReviewRequest={request}
          onCommentAction={async () => ({ commentPosted: false })}
          onCommented={onActed}
          onReviewSubmitted={onActed}
        />
      </>
    );
  }
  act(() => {
    renderer = create(<Review />);
  });
  act(() => approve().props.onClick());
  expect(renderer.root.findByType(Popover).props.open).toBe(true);
  act(() =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "Keep this summary" } }),
  );
  state.submit.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => submit().props.onClick());
  expect(state.submit).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, verdict: "approve", body: "Keep this summary", comments: [comment] },
  });
  act(() => renderer.root.findByType(Popover).props.onOpenChange(false));
  expect(renderer.root.findByType(Popover).props.open).toBe(false);
  act(() => option("Request changes").props.onClick());
  expect(renderer.root.findByType(Popover).props.open).toBe(true);
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this summary");
  expect(usePullRequestReviewStore.getState().drafts[key]).toEqual([comment]);
  await act(async () => submit().props.onClick());
  expect(state.submit).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      ...reference,
      verdict: "request-changes",
      body: "Keep this summary",
      comments: [comment],
    },
  });
  expect(renderer.root.findByType(Popover).props.open).toBe(false);
  expect(usePullRequestReviewStore.getState().drafts[key]).toBeUndefined();
  expect(usePullRequestReviewStore.getState().summaries[key]).toBeUndefined();
  act(() => approve().props.onClick());
  await act(async () => submit().props.onClick());
  expect(state.submit).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, verdict: "approve", body: "", comments: [] },
  });
  expect(state.run).not.toHaveBeenCalled();
});
