// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";
import { IssueDetailPanel, IssueReactionBar } from "./IssueDetailPanel";

const state = vi.hoisted(() => ({ react: vi.fn(), detail: null as IssueDetail | null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.react }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.detail, isPending: false, error: null }),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original()),
  useAtomValue: () => true,
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [], useThreadShell: () => null }));

const environmentId = EnvironmentId.make("environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "42",
};
const reactions = [
  { content: "thumbs-up" as const, count: 2, actors: [], viewerHasReacted: false },
];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([undefined, "latest-comment", "held-older-comment"])(
  "retains a successful add when a reverse write fails with stale native data (%s)",
  async (subjectId) => {
    state.react
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success" });
    await act(async () =>
      root.render(
        <IssueReactionBar
          reactions={reactions}
          canReact
          contents={undefined}
          viewer="viewer"
          environmentId={environmentId}
          reference={reference}
          subjectId={subjectId}
        />,
      ),
    );
    const pill = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().textContent).toContain("3");
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().textContent).toContain("3");
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("false");
    expect(pill().textContent).toContain("2");
    expect(state.react.mock.calls.map(([target]) => target.input.reacted)).toEqual([
      true,
      false,
      false,
    ]);
    for (const [target] of state.react.mock.calls)
      expect(target).toEqual({
        environmentId,
        input: {
          ...reference,
          ...(subjectId === undefined ? {} : { subjectId }),
          content: "thumbs-up",
          reacted: target.input.reacted,
        },
      });
  },
);

it.each([
  { canReact: false, contents: undefined },
  { canReact: true, contents: [] },
  { canReact: true, contents: ["heart" as const] },
])("keeps unsupported reaction counts read-only for %j", async ({ canReact, contents }) => {
  await act(async () =>
    root.render(
      <IssueReactionBar
        reactions={reactions}
        canReact={canReact}
        contents={contents}
        viewer="viewer"
        environmentId={environmentId}
        reference={reference}
      />,
    ),
  );
  const pill = container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
  expect(pill.disabled).toBe(true);
  await act(async () => pill.click());
  expect(state.react).not.toHaveBeenCalled();
  expect(pill.textContent).toContain("2");
});

function issueDetail(viewer: string | null, reacted: boolean, count: number): IssueDetail {
  const reaction = [
    { content: "thumbs-up" as const, count, actors: [], viewerHasReacted: reacted },
  ];
  return {
    ...reference,
    host: "github.com",
    projectTitle: "Project",
    displayKey: "#42",
    title: "Issue",
    url: "https://github.com/org/repo/issues/42",
    author: null,
    body: "",
    viewer,
    state: { category: "open", name: "Open" },
    writable: true,
    commentCount: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    labels: [],
    assignees: [],
    reactions: reaction,
    comments: [
      {
        id: "comment",
        author: null,
        body: "",
        createdAt: "2026-10-01T00:00:00Z",
        url: null,
        reactions: reaction,
      },
    ],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: true,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
  };
}

const renderPanel = (detail: IssueDetail) => {
  state.detail = detail;
  return act(async () =>
    root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
  );
};
const panelPills = () => [
  ...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="thumbs up,"]'),
];
const pressed = () => panelPills().map((pill) => pill.getAttribute("aria-pressed"));

it("forgets one account's unacknowledged reactions when the issue reads as another", async () => {
  state.react.mockResolvedValue({ _tag: "Success" });
  await renderPanel(issueDetail("alice", false, 2));
  for (const pill of panelPills()) await act(async () => pill.click());
  expect(pressed()).toEqual(["true", "true"]);

  await renderPanel(issueDetail("bob", false, 3));
  expect(pressed()).toEqual(["false", "false"]);
  for (const pill of panelPills()) await act(async () => pill.click());
  expect(state.react.mock.calls.map(([target]) => target.input.reacted)).toEqual([
    true,
    true,
    true,
    true,
  ]);
});

it("ignores a write that settles after the account changed", async () => {
  let settle: (result: { _tag: string }) => void = () => {};
  state.react.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
  await renderPanel(issueDetail("alice", false, 2));
  await act(async () => panelPills()[0]!.click());

  await renderPanel(issueDetail("bob", false, 3));
  expect(pressed()).toEqual(["false", "false"]);
  expect(panelPills()[0]!.disabled).toBe(false);
  await act(async () => settle({ _tag: "Success" }));
  expect(pressed()).toEqual(["false", "false"]);
  expect(panelPills()[0]!.disabled).toBe(false);
});

it("trusts a new read over an unknown account's presses but keeps them on a cached one", async () => {
  state.react.mockResolvedValue({ _tag: "Success" });
  const asA = issueDetail(null, false, 2);
  await renderPanel(asA);
  for (const pill of panelPills()) await act(async () => pill.click());
  await renderPanel({ ...asA });
  expect(pressed()).toEqual(["true", "true"]);

  await renderPanel(issueDetail(null, false, 3));
  expect(pressed()).toEqual(["false", "false"]);
  expect(panelPills().map((pill) => pill.textContent)).toEqual(["👍3", "👍3"]);
  for (const pill of panelPills()) await act(async () => pill.click());
  expect(state.react.mock.calls.map(([target]) => target.input.reacted)).toEqual([
    true,
    true,
    true,
    true,
  ]);
});

it("does not restore an unknown account's press when its reversal fails after a new read", async () => {
  let settle: (result: { _tag: string }) => void = () => {};
  state.react
    .mockResolvedValueOnce({ _tag: "Success" })
    .mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
  await renderPanel(issueDetail(null, false, 2));
  await act(async () => panelPills()[0]!.click());
  await act(async () => panelPills()[0]!.click());

  await renderPanel(issueDetail(null, false, 3));
  await act(async () => settle({ _tag: "Failure" }));
  expect(pressed()).toEqual(["false", "false"]);
});

it("keeps the same account's press through a stale read until the tracker agrees", async () => {
  state.react.mockResolvedValue({ _tag: "Success" });
  await renderPanel(issueDetail("alice", false, 2));
  for (const pill of panelPills()) await act(async () => pill.click());

  await renderPanel(issueDetail("alice", false, 2));
  expect(pressed()).toEqual(["true", "true"]);
  await renderPanel(issueDetail("alice", true, 3));
  await renderPanel(issueDetail("alice", false, 2));
  expect(pressed()).toEqual(["false", "false"]);
});
