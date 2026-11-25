import type { IssueDetail } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const url = "https://github.com/owner/repo/issues/7";
const detail = vi.hoisted(() => ({
  tracker: "github",
  host: "github.com",
  scope: "owner/repo",
  key: "7",
  displayKey: "#7",
  title: "Something is broken",
  url: "https://github.com/owner/repo/issues/7",
  author: null,
  state: { category: "open", name: "Open" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  projectId: "project-1",
  projectTitle: "Project",
  writable: false,
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
  },
  viewerPermissions: {
    setState: false,
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
  },
  states: [],
  viewer: null,
  body: "",
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
})) as unknown as IssueDetail;

const state = vi.hoisted(() => ({ openLink: vi.fn(async () => {}) }));

vi.mock(import("~/browser/useOpenLink"), () => ({ useOpenLink: () => state.openLink }));
vi.mock(import("./IssueThreadLinks"), () => ({ IssueThreadLinks: (() => null) as never }));
vi.mock(import("~/state/issues"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const detailAtom = Atom.make(AsyncResult.success(detail));
  return {
    ...actual,
    issueEnvironment: { ...actual.issueEnvironment, detail: (() => detailAtom) as never },
  };
});

import { IssueDetailPanel } from "./IssueDetailPanel";

describe("IssueDetailPanel", () => {
  it("opens the issue number through the link-target setting, not a popup", async () => {
    const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;
    await using screen = await render(
      <IssueDetailPanel
        environmentId={"env-1" as never}
        reference={{
          projectId: "project-1" as never,
          tracker: "github" as never,
          scope: "owner/repo",
          key: "7",
        }}
        threadRef={threadRef}
      />,
    );
    const number = screen.getByRole("link", { name: "Open #7 on GitHub" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    (await number.element()).dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(state.openLink).toHaveBeenCalledOnce();
    expect(state.openLink).toHaveBeenCalledWith(url, { event: expect.anything() });
  });
});
