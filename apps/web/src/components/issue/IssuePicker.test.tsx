// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { IssueAssigneePicker, IssueLabelPicker } from "./IssueDetailPanel";

const state = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      labels: ["W", "Other", "T"].map((id) => ({
        id,
        name: id === "Other" ? id : "Bug",
        description: id,
        color: null,
      })),
      assignees: ["W", "Other", "T"].map((id) => ({ id, login: id, name: null, avatarUrl: null })),
    },
    isPending: false,
    error: null,
  }),
}));

const environmentId = EnvironmentId.make("environment");
function detail(ids: string[], viewer: string | null = "viewer"): IssueDetail {
  return {
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "workspace/ENG",
    key: "ENG-42",
    displayKey: "ENG-42",
    title: "Issue",
    url: "https://linear.app/workspace/issue/ENG-42",
    author: null,
    body: "",
    viewer,
    state: { category: "open", name: "Open" },
    writable: true,
    commentCount: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    labels: ids.map((id) => ({ id, name: id === "W" || id === "T" ? "Bug" : id, color: null })),
    assignees: ids.map((id) => ({ id, login: id, name: null, avatarUrl: null })),
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
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
let root: Root;
let container: HTMLDivElement;
const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (getAnimationsDescriptor)
    Object.defineProperty(Element.prototype, "getAnimations", getAnimationsDescriptor);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

it.each(["labels", "assignees"] as const)(
  "keeps the last successful %s set through a late read and failed reversal",
  async (kind) => {
    let issue = detail(["W"]);
    let finish!: (value: unknown) => void;
    state.update
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockReturnValueOnce(
        new Promise((done) => {
          finish = done;
        }),
      )
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("denied")) })
      .mockResolvedValueOnce({ _tag: "Success" });
    const Picker = kind === "labels" ? IssueLabelPicker : IssueAssigneePicker;
    const render = async () =>
      act(async () =>
        root.render(
          <Picker
            detail={issue}
            reference={{
              projectId: issue.projectId,
              tracker: issue.tracker,
              host: issue.host,
              scope: issue.scope,
              key: issue.key,
            }}
            environmentId={environmentId}
            allowed
            disabledReason=""
            onUpdated={undefined}
          />,
        ),
      );
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    const option = (id: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
        element.textContent?.includes(id),
      )!;
    await act(async () => option("Other").click());
    await act(async () => option("T").click());
    expect(state.update.mock.calls[1]?.[0].input[kind]).toEqual(["W", "Other", "T"]);
    issue = detail(["W", "Other"]);
    await render();
    await act(async () => finish({ _tag: "Success" }));
    await act(async () => option("Other").click());
    expect(state.update.mock.calls[2]?.[0].input[kind]).toEqual(["W", "T"]);
    await act(async () => option("W").click());
    expect(state.update.mock.calls.map(([target]) => target.input[kind])).toEqual([
      ["W", "Other"],
      ["W", "Other", "T"],
      ["W", "T"],
      ["Other", "T"],
    ]);
  },
);

it.each(["labels", "assignees"] as const)(
  "keeps an unknown account's %s only until a new read names the native set",
  async (kind) => {
    let issue = detail(["W"], null);
    state.update.mockResolvedValue({ _tag: "Success" });
    const Picker = kind === "labels" ? IssueLabelPicker : IssueAssigneePicker;
    const render = async () =>
      act(async () =>
        root.render(
          <Picker
            detail={issue}
            reference={{
              projectId: issue.projectId,
              tracker: issue.tracker,
              host: issue.host,
              scope: issue.scope,
              key: issue.key,
            }}
            environmentId={environmentId}
            allowed
            disabledReason=""
            onUpdated={undefined}
          />,
        ),
      );
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    const option = (id: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
        element.textContent?.includes(id),
      )!;
    await act(async () => option("Other").click());
    await render();
    await act(async () => option("T").click());
    issue = detail(["Z"], null);
    await render();
    await act(async () => option("T").click());
    expect(state.update.mock.calls.map(([target]) => target.input[kind])).toEqual([
      ["W", "Other"],
      ["W", "Other", "T"],
      ["Z", "T"],
    ]);
  },
);

it.each(["environment", "account"] as const)(
  "does not apply an old completed write to the same issue on another %s",
  async (change) => {
    let issue = detail(["W"]);
    let targetEnvironmentId = environmentId;
    let finish!: (value: unknown) => void;
    state.update
      .mockReturnValueOnce(
        new Promise((done) => {
          finish = done;
        }),
      )
      .mockResolvedValueOnce({ _tag: "Success" });
    const render = async () =>
      act(async () =>
        root.render(
          <IssueLabelPicker
            detail={issue}
            reference={{
              projectId: issue.projectId,
              tracker: issue.tracker,
              host: issue.host,
              scope: issue.scope,
              key: issue.key,
            }}
            environmentId={targetEnvironmentId}
            allowed
            disabledReason=""
            onUpdated={undefined}
          />,
        ),
      );
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Change labels"]')!.click(),
    );
    const option = (id: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
        element.textContent?.includes(id),
      )!;
    await act(async () => option("Other").click());
    issue = detail(["Z"], change === "account" ? "another-viewer" : "viewer");
    if (change === "environment") targetEnvironmentId = EnvironmentId.make("another-environment");
    await render();
    await act(async () => finish({ _tag: "Success" }));
    await act(async () => option("T").click());
    expect(state.update.mock.calls[1]?.[0]).toMatchObject({
      environmentId: targetEnvironmentId,
      input: { labels: ["Z", "T"] },
    });
  },
);
