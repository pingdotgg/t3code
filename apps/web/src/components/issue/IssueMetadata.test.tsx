// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

const state = vi.hoisted(() => ({
  detail: null as IssueDetail | null,
  readError: null as string | null,
  readPending: false,
  update: vi.fn(),
  assigneeIds: ["W", "Other", "T", "Z"],
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("./useIssueThreadHandoff", () => ({
  useIssueThreadHandoff: () => ({ pending: false, start: vi.fn() }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.detail,
    error: state.readError,
    isPending: state.readPending,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/issues", async () => {
  const { Atom } = await import("effect/reactivity");
  const command = { permissionAtom: () => Atom.make(true) };
  const page = {
    hasMore: false,
    isPending: false,
    error: null,
    truncated: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    issueEnvironment: {
      detail: () => ({}),
      comment: command,
      create: command,
      update: command,
      setState: command,
    },
    useIssueComments: () => ({ ...page, items: [] }),
    useIssueLinkedPullRequests: () => ({ ...page, items: [] }),
    useIssueLabelCandidates: () => ({
      ...page,
      items: ["W", "Other", "T", "Z"].map((id) => ({
        id,
        name: id === "Other" ? "Extra label" : "Bug",
        color: "fef2c0",
        description: id,
      })),
    }),
    useIssueAssigneeCandidates: () => ({
      ...page,
      items: state.assigneeIds.map((id) => ({
        id,
        login: id === "Other" ? "Other-person" : id,
        name: id === "Other" ? "Extra person" : id,
        avatarUrl: null,
      })),
    }),
  };
});
import { IssueDetailPanel } from "./IssueDetailPanel";

const environmentId = EnvironmentId.make("environment");
function detail(ids: ReadonlyArray<string>, key = "ENG-1"): IssueDetail {
  return {
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "workspace/ENG",
    key,
    displayKey: key,
    title: "Issue",
    body: "",
    url: `https://linear.app/workspace/issue/${key}`,
    author: null,
    viewer: "viewer",
    state: { category: "open", name: "Todo" },
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    closedAt: null,
    labels: ids.map((id) => ({
      id,
      name: id === "Other" ? "Extra label" : "Bug",
      color: "fef2c0",
    })),
    assignees: ids.map((id) => ({
      id,
      login: id === "Other" ? "Other-person" : id,
      name: id === "Other" ? "Extra person" : id,
      avatarUrl: null,
    })),
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
    commentCount: 0,
    writable: true,
    viewerPermissions: {
      comment: false,
      edit: false,
      labels: true,
      assignees: true,
      setState: false,
    },
    capabilities: {
      create: false,
      edit: false,
      comment: false,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
      maxAssignees: 10,
    },
  };
}
let root: Root;
let container: HTMLDivElement;
const animations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
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
  state.detail = detail(["W"]);
  state.assigneeIds = ["W", "Other", "T", "Z"];
  state.readError = null;
  state.readPending = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (animations) Object.defineProperty(Element.prototype, "getAnimations", animations);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});
const render = (targetEnvironmentId = environmentId) =>
  root.render(
    <IssueDetailPanel
      environmentId={targetEnvironmentId}
      reference={{
        projectId: state.detail!.projectId,
        tracker: state.detail!.tracker,
        host: state.detail!.host,
        ...(state.detail!.connectionId === undefined
          ? {}
          : { connectionId: state.detail!.connectionId }),
        scope: state.detail!.scope,
        key: state.detail!.key,
      }}
    />,
  );
const option = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
    element.textContent?.includes(id),
  )!;
const selected = (id: string) => option(id).querySelector('[aria-label="Selected"]') !== null;

it.each([
  ["JIRAUSER123", "jirauser123"],
  ["AbCd:123", "abcd:123"],
])("selects and retains case-distinct Jira assignees %s and %s", async (first, second) => {
  state.assigneeIds = [first, second];
  const initial = detail([first]);
  state.detail = {
    ...initial,
    tracker: IssueTrackerKind.make("jira"),
    capabilities: { ...initial.capabilities, maxAssignees: 1 },
  };
  state.update.mockResolvedValue({ _tag: "Success" });
  await act(async () => render());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Change assignees"]')!.click(),
  );
  expect(selected(first)).toBe(true);
  expect(selected(second)).toBe(false);
  await act(async () => option(second).click());
  expect(state.update.mock.calls[0]![0].input.assignees).toEqual([second]);
  expect(selected(second)).toBe(true);
  expect(selected(first)).toBe(false);
  expect(container.textContent).toContain(second);
  expect(container.textContent).not.toContain(first);
  state.detail = { ...state.detail };
  await act(async () => render());
  expect(selected(second)).toBe(true);
  expect(container.textContent).toContain(second);
  expect(container.textContent).not.toContain(first);
  state.detail = { ...state.detail, assignees: detail([second]).assignees };
  await act(async () => render());
  state.detail = { ...state.detail, assignees: initial.assignees };
  await act(async () => render());
  expect(selected(first)).toBe(true);
  expect(selected(second)).toBe(false);
  await act(async () => option(first).click());
  expect(state.update.mock.calls[1]![0].input.assignees).toEqual([]);
});

function delayedWrite() {
  let resolve!: (value: { _tag: "Success" }) => void;
  const promise = new Promise<{ _tag: "Success" }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["labels", "assignees"] as const)(
  "clears confirmed %s when only the account changes",
  async (kind) => {
    state.detail = { ...detail(["W"]), connectionId: "A" };
    state.update.mockResolvedValue({ _tag: "Success" });
    await act(async () => render());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    await act(async () => option("Other").click());
    expect(selected("Other")).toBe(true);
    state.detail = { ...detail(["Z"]), connectionId: "B" };
    await act(async () => render());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    expect(selected("Other")).toBe(false);
    expect(selected("Z")).toBe(true);
    await act(async () => option("T").click());
    expect(state.update.mock.calls[1]![0].input).toMatchObject({
      connectionId: "B",
      [kind]: ["Z", "T"],
    });
  },
);

it.each(
  (["labels", "assignees"] as const).flatMap((kind) =>
    (
      [
        ["viewer-a", "viewer-b"],
        ["viewer-a", null],
        [null, "viewer-b"],
        ["viewer-a", "viewer-a"],
        [null, null],
      ] as const
    ).map(([from, to]) => ({ kind, from, to })),
  ),
)("scopes confirmed $kind to viewer $from -> $to", async ({ kind, from, to }) => {
  state.detail = { ...detail(["W"]), viewer: from };
  state.update.mockResolvedValue({ _tag: "Success" });
  await act(async () => render());
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
  );
  await act(async () => option("Other").click());
  expect(state.update.mock.calls[0]![0].input[kind]).toEqual(["W", "Other"]);
  expect(selected("Other")).toBe(true);
  state.readError = "read failed";
  await act(async () => render());
  expect(selected("Other")).toBe(true);
  state.readError = null;
  state.detail = { ...detail(["Z"]), viewer: to };
  await act(async () => render());
  const retained = from !== null && from === to;
  expect(selected("Other")).toBe(retained);
  expect(selected("Z")).toBe(!retained);
  await act(async () => option("T").click());
  expect(state.update.mock.calls[1]![0].input[kind]).toEqual(
    retained ? ["W", "Other", "T"] : ["Z", "T"],
  );
});

it.each(["labels", "assignees"] as const)(
  "keeps confirmed %s through failed reads and writes until whole-set ACK, then clears on switch",
  async (kind) => {
    const second = delayedWrite();
    const late = delayedWrite();
    state.update
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("denied")) })
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce({ _tag: "Success" });
    await act(async () => render());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    await act(async () => option("Other").click());
    expect(selected("Other")).toBe(true);
    expect(container.textContent).toContain(kind === "labels" ? "Extra label" : "Other-person");
    state.detail = detail(["W"]);
    state.readError = "read failed";
    await act(async () => render());
    expect(selected("Other")).toBe(true);
    state.readError = null;
    state.readPending = true;
    await act(async () => render());
    await act(async () => option("T").click());
    expect(state.update.mock.calls[1]![0].input[kind]).toEqual(["W", "Other", "T"]);
    state.detail = detail(["W", "Other"]);
    state.readPending = false;
    await act(async () => render());
    await act(async () => second.resolve({ _tag: "Success" }));
    expect(selected("T")).toBe(true);
    await act(async () => option("Other").click());
    expect(state.update.mock.calls[2]![0].input[kind]).toEqual(["W", "T"]);
    expect(selected("Other")).toBe(true);
    expect(selected("T")).toBe(true);
    state.detail = detail(["T", "Other", "W"]);
    await act(async () => render());
    state.detail = detail(["W"]);
    await act(async () => render());
    expect(selected("Other")).toBe(false);
    expect(selected("T")).toBe(false);
    await act(async () => option("Other").click());
    state.detail = detail(["Z"], "ENG-2");
    await act(async () => render());
    await act(async () => late.resolve({ _tag: "Success" }));
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    expect(selected("Other")).toBe(false);
    await act(async () => option("Other").click());
    expect(state.update.mock.calls[4]![0].input[kind]).toEqual(["Z", "Other"]);
  },
);

it.each(["labels", "assignees"] as const)(
  "ignores a late %s write after an environment-only switch",
  async (kind) => {
    const late = delayedWrite();
    state.update.mockReturnValueOnce(late.promise).mockResolvedValueOnce({ _tag: "Success" });
    await act(async () => render());
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    await act(async () => option("Other").click());
    state.detail = detail(["Z"]);
    const otherEnvironmentId = EnvironmentId.make("another-environment");
    await act(async () => render(otherEnvironmentId));
    await act(async () => late.resolve({ _tag: "Success" }));
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Change ${kind}"]`)!.click(),
    );
    expect(selected("Other")).toBe(false);
    await act(async () => option("Other").click());
    expect(state.update.mock.calls[1]![0]).toMatchObject({
      environmentId: otherEnvironmentId,
      input: { [kind]: ["Z", "Other"] },
    });
  },
);
