// @vitest-environment jsdom

import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueEvent,
  type IssueDetail,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/issues", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    issueEnvironment: { setParent: { permissionAtom: () => Atom.make(false) } },
    useIssueHierarchy: () => ({
      items: [],
      extra: null,
      hasMore: false,
      isPending: false,
      error: null,
      truncated: false,
      loadMore: () => {},
    }),
  };
});
vi.mock("../pullRequest/PullRequestMarkdownEditor", () => ({
  PullRequestMarkdownEditor: () => null,
}));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({ PullRequestCommentBody: () => null }));
vi.mock("./IssueRichBodyEditor", () => ({
  IssueRichBodyEditor: () => null,
  IssueRichBodyView: () => null,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));

import { IssueEventRow } from "./IssueConversation";
import { IssueHierarchySection } from "./IssueRelations";

const event: IssueEvent = {
  id: "native-event-1",
  kind: "referenced",
  url: "https://github.example.test/Org/Repo/issues/42#event-123",
  reference: {
    url: "https://github.example.test/Org/Repo/pull/72?source=timeline#native-anchor",
    identifier: "Org/Repo#72",
    title: "Fix the native issue",
  },
  actor: { id: "actor-1", login: "dev", name: "Developer", avatarUrl: null },
  createdAt: "2026-10-15T09:00:00Z",
  detail: "Native reference",
};
let container: HTMLDivElement;
let root: Root;
const render = (value: IssueEvent) => act(async () => root.render(<IssueEventRow event={value} />));
beforeEach(() => {
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

it("opens the exact native source and event URLs and shows source identity, actor and time", async () => {
  await render(event);
  const links = [...container.querySelectorAll("a")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual([event.reference!.url, event.url]);
  expect(links[0]!.textContent).toContain("Org/Repo#72");
  expect(links[0]!.textContent).toContain("Fix the native issue");
  expect(container.textContent).toContain("dev");
  expect(container.querySelector("time")?.dateTime).toBe(event.createdAt);
  const clicked: string[] = [];
  container.addEventListener("click", (click) => {
    click.preventDefault();
    clicked.push((click.target as Element).closest("a")!.getAttribute("href")!);
  });
  await act(async () => {
    links[0]!.click();
    links[1]!.click();
  });
  expect(clicked).toEqual([event.reference!.url, event.url]);
  for (const link of links) {
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  }
});

it.each(["javascript:alert(1)", "data:text/html,unsafe", "/guessed/path", "file:///private"])(
  "keeps unsafe event and reference URLs inert: %s",
  async (url) => {
    await render({ ...event, url, reference: { ...event.reference!, url } });
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Org/Repo#72");
    expect(container.textContent).toContain("Fix the native issue");
    expect(container.querySelector("time")).not.toBeNull();
  },
);

it("does not invent links when the native event has no URLs", async () => {
  await render({
    id: event.id,
    kind: "referenced",
    detail: "Mentioned by another issue",
    actor: null,
    createdAt: event.createdAt,
  });
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toContain("Mentioned by another issue");
});

it("preserves native HTTP permalinks exactly", async () => {
  const url = "http://forgejo.example.test/Forge/Org/Repo/issues/42#issuecomment-001";
  await render({ ...event, url });
  expect(container.querySelector("time")?.closest("a")?.getAttribute("href")).toBe(url);
});

it.each([undefined, "Tasks"])(
  "names the empty hierarchy sections clearly (%s)",
  async (subIssueNoun) => {
    const reference = {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("github"),
      host: "github.example.test",
      scope: "Org/Repo",
      key: "42",
    };
    const detail: IssueDetail = {
      ...reference,
      projectTitle: "Project",
      displayKey: "#42",
      title: "Issue",
      url: "https://github.example.test/Org/Repo/issues/42",
      body: "",
      author: null,
      viewer: null,
      state: { category: "open", name: "open" },
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      closedAt: null,
      labels: [],
      assignees: [],
      comments: [],
      commentsCursor: null,
      events: [],
      linkedPullRequests: [],
      commentCount: 0,
      writable: false,
      viewerPermissions: {
        comment: false,
        edit: false,
        labels: false,
        assignees: false,
        setState: false,
      },
      capabilities: {
        create: false,
        edit: false,
        comment: false,
        labels: false,
        assignees: false,
        reactions: false,
        templates: false,
        linkedPullRequests: false,
        events: false,
        search: false,
        states: [],
        closeReasons: [],
        ...(subIssueNoun === undefined ? {} : { subIssueNoun }),
      },
    };
    await act(async () =>
      root.render(
        <IssueHierarchySection
          environmentId={EnvironmentId.make("environment")}
          reference={reference}
          detail={detail}
          onSelectIssue={undefined}
          onCreateSubIssue={null}
        />,
      ),
    );
    expect([...container.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Parent",
      subIssueNoun ?? "Sub-issues",
    ]);
    expect(container.textContent).toContain("No parent issue.");
    expect(container.textContent).toContain(
      subIssueNoun === undefined ? "No sub-issues." : "No tasks.",
    );
    expect(container.textContent).not.toContain("None");
  },
);
