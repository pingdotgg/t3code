import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestRef,
  type PullRequestReviewVerdict,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useRef, useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render as renderUi } from "../../../test/render";

const state = vi.hoisted(() => ({
  permission: null as Atom.Writable<boolean> | null,
  run: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  submit: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  toast: vi.fn(),
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      runHostAction: {
        ...actual.pullRequestEnvironment.runHostAction,
        permissionAtom: () => state.permission!,
      },
      submitReview: {
        ...actual.pullRequestEnvironment.submitReview,
        permissionAtom: () => state.permission!,
      },
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { pullRequestEnvironment } = await import("~/state/pullRequests");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === pullRequestEnvironment.runHostAction ? state.run : state.submit) as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { PullRequestReviewButton } from "./PullRequestReviewButton";
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
function buttonNode(value = detail, actionPending = false) {
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
const approve = () => page.getByRole("button", { name: "Approve pull request", exact: true });
const options = () => page.getByRole("button", { name: "Other review options", exact: true });
const selectOption = async (label: string) => {
  await options().click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
};
const submit = () => page.getByRole("button", { name: "Submit review", exact: true });
const composer = () => page.getByRole("dialog", { name: "Pull request composer" });
const summary = () => page.getByRole("textbox", { name: "Review summary" });

function setup() {
  state.permission = Atom.make(true);
  const registry = AtomRegistry.make();
  state.run.mockReset().mockResolvedValue({ _tag: "Success", value: { message: "Vote recorded" } });
  state.submit.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toast.mockReset();
  onActed.mockReset();
  onReview.mockReset();
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });

  return {
    registry,
    wrap: (node: ReactNode) => (
      <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("sends one Azure vote for repeated clicks and locks all votes until completion", async () => {
  using fixture = setup();
  let complete!: (value: unknown) => void;
  state.run.mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
  await using _screen = await renderUi(fixture.wrap(buttonNode()));
  const button = approve().element() as HTMLButtonElement;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, action: { type: "vote", vote: "approve" } },
  });
  await expect.element(page.getByRole("button", { name: "Submitting review" })).toBeDisabled();
  await expect.element(options()).toBeDisabled();
  await act(async () => (options().element() as HTMLButtonElement).click());
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  expect(state.run).toHaveBeenCalledTimes(1);
  expect(onActed).not.toHaveBeenCalled();
  await act(async () => complete({ _tag: "Success", value: { message: "Vote recorded" } }));
  expect(onActed).toHaveBeenCalledOnce();
  await selectOption("Reset feedback");
  expect(state.run).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, action: { type: "vote", vote: "reset" } },
  });
});

it.each(["typed", "rejected", "thrown"] as const)(
  "reports a %s Azure refusal and unlocks the vote for retry",
  async (failure) => {
    using fixture = setup();
    if (failure === "typed")
      state.run.mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("Vote refused")),
      });
    else if (failure === "rejected") state.run.mockRejectedValueOnce(new Error("Vote refused"));
    else
      state.run.mockImplementationOnce(() => {
        throw new Error("Vote refused");
      });
    await using _screen = await renderUi(fixture.wrap(buttonNode()));
    await approve().click();
    expect(onActed).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await expect.element(approve()).toBeEnabled();
    await approve().click();
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(onActed).toHaveBeenCalledOnce();
  },
);

it.each([
  { allowed: false, denial: undefined, reason: "This connection does not allow" },
  { allowed: true, denial: "Branch policy forbids voting.", reason: "Branch policy" },
])("refuses denied Azure votes with an explanation: $reason", async (scenario) => {
  using fixture = setup();
  fixture.registry.set(state.permission!, scenario.allowed);
  await using _screen = await renderUi(
    fixture.wrap(
      buttonNode({
        ...detail,
        viewerPermissions: {
          ...detail.viewerPermissions,
          deniedActions: scenario.denial ? { vote: scenario.denial } : {},
        },
      }),
    ),
  );
  await expect.element(approve()).toBeDisabled();
  await expect.element(options()).toBeDisabled();
  await expect
    .element(page.getByText(scenario.reason, { exact: false }).first())
    .toBeInTheDocument();
  await act(async () => {
    (approve().element() as HTMLButtonElement).click();
    (options().element() as HTMLButtonElement).click();
  });
  expect(state.run).not.toHaveBeenCalled();
});

it("refuses another vote while a panel action is pending", async () => {
  using fixture = setup();
  await using _screen = await renderUi(fixture.wrap(buttonNode(detail, true)));
  await expect.element(approve()).toBeDisabled();
  await act(async () => (approve().element() as HTMLButtonElement).click());
  expect(state.run).not.toHaveBeenCalled();
});

it.each(["gitlab", "forgejo", "bitbucket", "gitcafe"])(
  "does not expose the review shortcut for %s",
  async (provider) => {
    using fixture = setup();
    await using _screen = await renderUi(
      fixture.wrap(buttonNode({ ...detail, provider: SourceControlProviderKind.make(provider) })),
    );
    await expect
      .element(page.getByRole("group", { name: "Review pull request" }))
      .not.toBeInTheDocument();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.submit).not.toHaveBeenCalled();
  },
);
it.each(["closed", "merged"] as const)(
  "does not offer voting on a %s pull request",
  async (prState) => {
    using fixture = setup();
    await using _screen = await renderUi(fixture.wrap(buttonNode({ ...detail, state: prState })));
    await expect
      .element(page.getByRole("group", { name: "Review pull request" }))
      .not.toBeInTheDocument();
    expect(onReview).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  },
);

const githubDetail: PullRequestDetailView = {
  ...detail,
  provider: SourceControlProviderKind.make("github"),
  capabilities: { ...detail.capabilities, hostActions: false },
};

it("removes Azure voting in draft mode and restores it after publication", async () => {
  using fixture = setup();
  await using screen = await renderUi(fixture.wrap(buttonNode({ ...detail, isDraft: true })));
  await expect.element(approve()).not.toBeInTheDocument();
  await screen.rerender(fixture.wrap(buttonNode()));
  await approve().click();
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, action: { type: "vote", vote: "approve" } },
  });
  await screen.rerender(fixture.wrap(buttonNode({ ...detail, isDraft: true })));
  await expect.element(approve()).not.toBeInTheDocument();
});

it("continues to offer reviews on GitHub drafts", async () => {
  using fixture = setup();
  await using _screen = await renderUi(
    fixture.wrap(buttonNode({ ...githubDetail, isDraft: true })),
  );
  await approve().click();
  expect(onReview).toHaveBeenCalledExactlyOnceWith("approve");
  expect(state.run).not.toHaveBeenCalled();
});

it("uses the requested GitHub verdict on the form's first mount", async () => {
  using fixture = setup();
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
  await using _screen = await renderUi(fixture.wrap(<Form />));
  await expect.element(submit()).toBeEnabled();
  await submit().click();
  expect(state.submit).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { ...reference, verdict: "approve", body: "", comments: [] },
  });
});

it("reopens GitHub reviews with the requested verdict and preserves drafts through a failed submission", async () => {
  using fixture = setup();
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
  await using _screen = await renderUi(fixture.wrap(<Review />));
  await approve().click();
  await expect.element(composer()).toBeVisible();
  await userEvent.fill(summary(), "Keep this summary");
  state.submit.mockResolvedValueOnce({ _tag: "Failure" });
  await submit().click();
  expect(state.submit).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, verdict: "approve", body: "Keep this summary", comments: [comment] },
  });
  await page.getByRole("button", { name: "Close composer", exact: true }).click();
  await expect.element(composer()).not.toBeInTheDocument();
  await selectOption("Request changes");
  await expect.element(composer()).toBeVisible();
  await expect.element(summary()).toHaveValue("Keep this summary");
  expect(usePullRequestReviewStore.getState().drafts[key]).toEqual([comment]);
  await submit().click();
  expect(state.submit).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      ...reference,
      verdict: "request-changes",
      body: "Keep this summary",
      comments: [comment],
    },
  });
  await expect.element(composer()).not.toBeInTheDocument();
  expect(usePullRequestReviewStore.getState().drafts[key]).toBeUndefined();
  expect(usePullRequestReviewStore.getState().summaries[key]).toBeUndefined();
  await approve().click();
  await submit().click();
  expect(state.submit).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, verdict: "approve", body: "", comments: [] },
  });
  expect(state.run).not.toHaveBeenCalled();
});
