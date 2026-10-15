// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueDetail,
  type IssueState,
} from "@t3tools/contracts";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { IssueDetailPanel } from "./IssueDetailPanel";

const state = vi.hoisted(() => ({
  setState: vi.fn(),
  navigate: vi.fn(),
  detail: null as IssueDetail | null,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original()),
  useCanGoBack: () => true,
  useNavigate: () => state.navigate,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.setState }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.detail, isPending: false, error: null }),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original()),
  useAtomValue: () => true,
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({
  PullRequestCommentBody: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/state/entities", () => ({
  useProjects: () => [],
  useThreadShell: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
}));

const environmentId = EnvironmentId.make("environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("jira"),
  host: "acme.atlassian.net",
  scope: "ENG",
  key: "ENG-1",
};
const generic = [
  { category: "open", name: "open" },
  { category: "closed", name: "closed" },
] as const;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.setState.mockResolvedValue({ _tag: "Success" });
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

const render = (
  current: IssueState,
  closeReasons: ReadonlyArray<string>,
  states: ReadonlyArray<IssueState> = generic,
  extra: Partial<IssueDetail> = {},
) => {
  state.detail = {
    ...reference,
    projectTitle: "Project",
    displayKey: reference.key,
    title: "Issue",
    url: "https://acme.atlassian.net/browse/ENG-1",
    author: null,
    body: "",
    viewer: null,
    state: current,
    writable: true,
    commentCount: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    labels: [],
    assignees: [],
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
      states,
      closeReasons,
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    ...extra,
  };
  return act(async () =>
    root.render(<IssueDetailPanel environmentId={environmentId} reference={reference} />),
  );
};
const actions = () =>
  [...container.querySelectorAll("button")]
    .map((button) => button.textContent ?? "")
    .filter((label) => /Reopen|Close|Move to/.test(label));

it.each([
  [{ category: "open", name: "In Progress" }, ["Close"]],
  [{ category: "closed", name: "Done" }, ["Reopen"]],
] as const)("offers only the opposite of a native %j state", async (current, expected) => {
  await render(current, []);
  expect(actions()).toEqual(expected);
});

it("keeps a native closed state's other close reason and its reopen", async () => {
  await render({ category: "closed", name: "Canceled", closeReason: "canceled" }, [
    "completed",
    "canceled",
  ]);
  expect(actions()).toEqual(["Reopen", "Close as completed"]);
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Close as completed")!
      .click(),
  );
  expect(state.setState.mock.calls[0]?.[0].input).toMatchObject({
    state: "closed",
    closeReason: "completed",
  });
});

it("keeps every close reason for a closed issue that recorded none", async () => {
  await render({ category: "closed", name: "closed" }, ["completed", "not-planned"]);
  expect(actions()).toEqual(["Reopen", "Close as completed", "Close as not planned"]);
});

it("keeps a named workflow's other states and hides only the current one", async () => {
  await render(
    { category: "open", name: "Active" },
    [],
    [
      { category: "open", name: "New" },
      { category: "open", name: "Active" },
      { category: "closed", name: "Done" },
    ],
  );
  expect(actions()).toEqual(["Close", "Move to New", "Move to Done"]);
});

it("offers both close reasons from a native open state", async () => {
  await render({ category: "open", name: "Todo" }, ["completed", "canceled"]);
  expect(actions()).toEqual(["Close", "Close as completed", "Close as canceled"]);
});

it.each([
  [
    [
      { category: "open", name: "To Do" },
      { category: "open", name: "In Progress" },
      { category: "closed", name: "Done" },
    ],
    "Move to Done",
    ["Close", "Move to In Progress", "Move to Done"],
  ],
  [
    [
      { category: "open", name: "To Do" },
      { category: "open", name: "Review" },
      { category: "closed", name: "Shipped" },
    ],
    "Move to Review",
    ["Close", "Move to Review", "Move to Shipped"],
  ],
] as const)(
  "offers the issue's own native states over the tracker's generic ones",
  async (native, pick, expected) => {
    await render({ category: "open", name: "To Do" }, [], generic, { states: native });
    expect(actions()).toEqual(expected);
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === pick)!
        .click(),
    );
    expect(state.setState.mock.calls[0]?.[0].input).toMatchObject({ state: pick.slice(8) });
  },
);

const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};
const open = { category: "open", name: "open" } as const;
const description = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]');

it("saves only the title of an issue whose rich description cannot be edited here", async () => {
  await render(open, [], generic, { body: "Rich *text*", bodyEditable: false });
  expect(button("Edit description")).toBeUndefined();
  expect(container.textContent).toContain("Rich");
  expect(
    [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Edit description on Jira",
    )?.href,
  ).toBe(state.detail!.url);
  await act(async () => button("Edit title")!.click());
  await act(async () => type(container.querySelector("input")!, "Renamed"));
  await act(async () => button("Save")!.click());
  expect(state.setState.mock.calls[0]?.[0].input).toEqual({ ...reference, title: "Renamed" });
});

it.each([undefined, true])(
  "edits a plain description when bodyEditable is %s",
  async (bodyEditable) => {
    await render(open, [], generic, {
      body: "Old",
      ...(bodyEditable === undefined ? {} : { bodyEditable }),
    });
    expect(container.textContent).not.toContain("Edit description on");
    await act(async () => button("Edit description")!.click());
    await act(async () => type(description()!, "New"));
    await act(async () => button("Save")!.click());
    expect(state.setState.mock.calls[0]?.[0].input).toEqual({ ...reference, body: "New" });
  },
);

it("keeps the description draft after a refused save so it can be retried", async () => {
  state.setState
    .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("denied")) })
    .mockResolvedValueOnce({ _tag: "Success" });
  await render(open, [], generic, { body: "Old" });
  await act(async () => button("Edit description")!.click());
  await act(async () => type(description()!, "New"));
  await act(async () => button("Save")!.click());
  expect(description()?.value).toBe("New");
  await act(async () => button("Save")!.click());
  expect(state.setState.mock.calls.map((call) => call[0].input.body)).toEqual(["New", "New"]);
  expect(description()).toBeNull();
});

function IssuesPage() {
  useEscapeToGoBack();
  return <IssueDetailPanel environmentId={environmentId} reference={reference} />;
}

it("cancels a title edit with Escape without leaving the issues page", async () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
  await render(open, [], generic);
  await act(async () => root.render(<IssuesPage />));
  await act(async () => button("Edit title")!.click());
  const title = container.querySelector<HTMLInputElement>('input[aria-label="Issue title"]')!;
  await act(async () => {
    title.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(container.querySelector('input[aria-label="Issue title"]')).toBeNull();
  expect(back).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  back.mockRestore();
});

it("keeps a typed comment on Escape, leaves from an empty one, and still sends on Ctrl+Enter", async () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
  await render(open, [], generic);
  await act(async () => root.render(<IssuesPage />));
  const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')!;
  const press = (init: KeyboardEventInit) =>
    act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  await act(async () => type(box, "half a reply"));
  await press({ key: "Escape" });
  expect(box.value).toBe("half a reply");
  expect(back).not.toHaveBeenCalled();
  await press({ key: "Enter", ctrlKey: true });
  expect(state.setState.mock.calls.map((call) => call[0].input.body)).toEqual(["half a reply"]);
  expect(box.value).toBe("");
  await press({ key: "Escape" });
  expect(back).toHaveBeenCalledOnce();
  back.mockRestore();
});
