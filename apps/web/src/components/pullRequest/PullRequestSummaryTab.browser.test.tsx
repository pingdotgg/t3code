import { SourceControlProviderKind } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => command) as never,
}));

function setup() {
  command.mockReset();
  command.mockResolvedValue({ _tag: "Success", value: undefined });
}

import { act, render as renderUi } from "../../../test/render";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

// The comment filter persists to localStorage, so tests that touch it start and end empty.

const tab = (value = detail) => (
  <PullRequestSummaryTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    threadRef={null}
    reference={value}
    detail={value}
    activityPending={false}
    activityError={null}
    onRefresh={() => {}}
  />
);

async function render(value = detail) {
  const screen = await renderUi(tab(value));
  const { container } = screen;
  const heading = (title: string) => {
    const section = container.querySelector(`section[aria-label="${title}"]`);
    expect(section, `section ${title}`).not.toBeNull();
    return [...section!.querySelectorAll("button")].find(
      (button) => button.querySelector("span")?.textContent === title,
    )!;
  };
  return Object.assign(screen, {
    click: (title: string) => act(async () => heading(title).click()),
    expanded: (title: string) => heading(title).getAttribute("aria-expanded"),
    visibleText: () => container.innerText,
  });
}

it("keeps an unsaved description when collapsed and reopened", async () => {
  setup();
  await using screen = await render();
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Unsaved description");
  await screen.click("Description");
  expect(screen.expanded("Description")).toBe("false");
  await screen.click("Description");
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");
});

it("keeps tasks clickable while saving, saves quick ticks in order, and holds the editor", async () => {
  setup();
  let finishFirstSave = (_result: unknown) => {};
  command.mockReturnValueOnce(new Promise((resolve) => (finishFirstSave = resolve)));
  // The image line splits the body, so the task list renders from a segment that starts mid-body.
  const body = "Intro\n\nhttps://example.com/shot.png\n\n## Test plan\n- [ ] First\n- [ ] Second";
  await using screen = await render({ ...detail, body });
  const boxes = () => screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes()).toHaveLength(2);
  const edit = () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!;

  await userEvent.click(boxes()[1]!);
  expect(boxes()[0]!.disabled).toBe(false);
  // A manual save racing a tick save could land first and be overwritten.
  expect(edit().disabled).toBe(true);
  await userEvent.click(boxes()[0]!);
  expect(command).toHaveBeenCalledTimes(1);
  await act(async () => finishFirstSave({ _tag: "Success", value: undefined }));

  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(edit().disabled).toBe(false));
  const [firstBody, latestBody] = command.mock.calls.map(([call]) => call.input.body);
  expect([firstBody, latestBody]).toEqual([
    body.replace("- [ ] Second", "- [x] Second"),
    body.replace("- [ ] First", "- [x] First").replace("- [ ] Second", "- [x] Second"),
  ]);

  // A refresh that lands after the saves can still carry the body from before the last tick.
  const ticked = () => [...boxes()].map((box) => box.checked);
  await screen.rerender(tab({ ...detail, body: firstBody }));
  expect(ticked()).toEqual([true, true]);
  await screen.rerender(tab({ ...detail, body: "- [ ] Edited on the host" }));
  expect(ticked()).toEqual([false]);
  // That body ended the edit, so the host's copy shows again even if it matches an old one.
  await screen.rerender(tab({ ...detail, body }));
  expect(ticked()).toEqual([false, false]);
});

it("saves a tick made as the previous save finishes, before the next render", async () => {
  setup();
  let finishFirstSave = (_result: unknown) => {};
  const firstSave = new Promise((resolve) => (finishFirstSave = resolve));
  command.mockReturnValueOnce(firstSave);
  const body = "- [ ] First\n- [ ] Second";
  await using screen = await render({ ...detail, body });
  const boxes = () => screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

  await userEvent.click(boxes()[1]!);
  // `act` holds the render, so the click lands after the save loop ended but before it shows.
  await act(async () => {
    finishFirstSave({ _tag: "Success", value: undefined });
    await firstSave;
    boxes()[0]!.click();
  });

  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));
  expect(command.mock.calls[1]![0].input.body).toBe("- [x] First\n- [x] Second");
});

it("leaves task checkboxes read-only for a viewer who can't edit the description", async () => {
  setup();
  await using screen = await render({
    ...detail,
    body: "- [ ] First",
    viewer: "someone-else",
  });
  const box = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(box.disabled).toBe(true);
});
