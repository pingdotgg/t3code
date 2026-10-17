// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import type {
  IssueEvent,
  IssueHistoryInput,
  IssueHistoryPage,
  IssueListOrder,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const historyRequests = vi.hoisted(() =>
  vi.fn<(target: { environmentId: string; input: IssueHistoryInput }) => void>(),
);
const observeHistory = vi.fn();

vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../pullRequest/PullRequestMarkdownEditor", () => ({
  PullRequestMarkdownEditor: () => null,
}));
vi.mock("../pullRequest/PullRequestCommentBody", () => ({ PullRequestCommentBody: () => null }));
vi.mock("./IssueRichBodyEditor", () => ({
  IssueRichBodyEditor: () => null,
  IssueRichBodyView: () => null,
}));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("@t3tools/client-runtime/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const pages = Atom.family((_key: string) => {
    const value = Atom.make<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>(
      AsyncResult.success({ items: [], nextCursor: null }),
    ).pipe(Atom.keepAlive);
    return Atom.writable(
      (get) => get(value),
      (get, result: AsyncResult.AsyncResult<IssueHistoryPage, unknown>) => get.set(value, result),
      () => undefined,
    ).pipe(Atom.keepAlive);
  });
  return {
    createIssueEnvironmentAtoms: () => ({
      history: (target: { environmentId: string; input: IssueHistoryInput }) => {
        historyRequests(target);
        return pages(JSON.stringify(target));
      },
    }),
  };
});
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment } from "~/state/issues";
import { IssueHistory, IssueOrderControl } from "./IssueHistory";

const environmentId = EnvironmentId.make("environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
};
const event = (detail: string): IssueEvent => ({
  id: detail,
  kind: "changed",
  detail,
  actor: null,
  createdAt: "2026-10-14T00:00:00Z",
});
const page = (cursor?: string, order: IssueListOrder | null = "desc", connectionId?: string) =>
  issueEnvironment.history({
    environmentId,
    input: {
      ...reference,
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(order === null ? {} : { order }),
      ...(cursor === undefined ? {} : { cursor }),
    },
  }) as Atom.Writable<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>;
let container: HTMLDivElement;
let root: Root;
let intersect: () => void;
const retry = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retry",
  );
const render = (
  order: IssueListOrder = "desc",
  orders?: ReadonlyArray<IssueListOrder>,
  connectionId?: string,
) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueHistory
          environmentId={environmentId}
          reference={{ ...reference, ...(connectionId === undefined ? {} : { connectionId }) }}
          order={order}
          orders={orders}
          url="https://gitlab.example.test/group/repo/-/issues/1"
        />
      </RegistryContext.Provider>,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  historyRequests.mockClear();
  observeHistory.mockClear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {
        observeHistory();
      }
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows the later-page failure and can retry while keeping earlier history", async () => {
  appAtomRegistry.set(
    page(),
    AsyncResult.success({ items: [event("First event")], nextCursor: "next" }),
  );
  const next = page("next");
  appAtomRegistry.set(
    next,
    AsyncResult.failure(Cause.fail(new Error("Temporary tracker failure"))),
  );
  await render();
  await act(async () => intersect());
  expect(container.textContent).toContain("First event");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Temporary tracker failure",
  );
  const refresh = vi.spyOn(appAtomRegistry, "refresh").mockImplementation((atom) => {
    if (atom === next)
      appAtomRegistry.set(
        next,
        AsyncResult.success({ items: [event("Later event")], nextCursor: null }),
      );
  });
  await act(async () => retry()!.click());
  expect(refresh).toHaveBeenCalledExactlyOnceWith(next);
  expect(container.textContent).toContain("First event");
  expect(container.textContent).toContain("Later event");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it.each(["2", "notes:2"])("loads history after an empty native page (%s)", async (cursor) => {
  appAtomRegistry.set(page(), AsyncResult.success({ items: [], nextCursor: cursor }));
  appAtomRegistry.set(
    page(cursor),
    AsyncResult.success({ items: [event("State changed")], nextCursor: null }),
  );
  await render();
  expect(container.querySelector('[aria-label="Load more history"]')).not.toBeNull();
  expect(container.textContent).not.toContain("No history yet.");
  await act(async () => intersect());
  expect(container.textContent).toContain("State changed");
  expect(retry()).toBeUndefined();
});

it("can retry a failed history continuation when all earlier pages are empty", async () => {
  appAtomRegistry.set(page(), AsyncResult.success({ items: [], nextCursor: "notes:2" }));
  const next = page("notes:2");
  appAtomRegistry.set(
    next,
    AsyncResult.failure(Cause.fail(new Error("Temporary tracker failure"))),
  );
  await render();
  expect(container.querySelector('[aria-label="Load more history"]')).not.toBeNull();
  await act(async () => intersect());
  expect(container.textContent).toContain("Temporary tracker failure");
  expect(container.querySelector('[aria-label="Load more history"]')).not.toBeNull();
  const refresh = vi.spyOn(appAtomRegistry, "refresh").mockImplementation((atom) => {
    if (atom === next)
      appAtomRegistry.set(
        next,
        AsyncResult.success({ items: [event("State changed")], nextCursor: null }),
      );
  });
  await act(async () => retry()!.click());
  expect(refresh).toHaveBeenCalledExactlyOnceWith(next);
  expect(container.textContent).toContain("State changed");
  expect(retry()).toBeUndefined();
  expect(container.textContent).not.toContain("Temporary tracker failure");
});

it("keeps the empty terminal history message without a continuation", async () => {
  appAtomRegistry.set(page(), AsyncResult.success({ items: [], nextCursor: null }));
  await render();
  expect(container.textContent).toContain("No history yet.");
  expect(retry()).toBeUndefined();
});

it("keeps the initial history error without a continuation", async () => {
  appAtomRegistry.set(
    page(),
    AsyncResult.failure(Cause.fail(new Error("Initial tracker failure"))),
  );
  await render();
  expect(container.textContent).toContain("The history could not be read. Initial tracker failure");
  expect(retry()).toBeUndefined();
});

it("requests the selected end and clears prior pages on order or account changes", async () => {
  appAtomRegistry.set(
    page(),
    AsyncResult.success({ items: [event("Newest window")], nextCursor: "older" }),
  );
  appAtomRegistry.set(
    page("older"),
    AsyncResult.success({ items: [event("Older window")], nextCursor: null }),
  );
  appAtomRegistry.set(
    page(undefined, "asc"),
    AsyncResult.success({ items: [event("Oldest window")], nextCursor: null }),
  );
  appAtomRegistry.set(
    page(undefined, "asc", "other-account"),
    AsyncResult.success({ items: [event("Other account")], nextCursor: null }),
  );
  await render();
  expect(container.textContent).toContain("Newest window");
  await act(async () => intersect());
  expect(container.textContent).toContain("Older window");
  await render("asc");
  expect(container.textContent).toContain("Oldest window");
  expect(container.textContent).not.toContain("Newest window");
  expect(container.textContent).not.toContain("Older window");
  await render("asc", undefined, "other-account");
  expect(container.textContent).toContain("Other account");
  expect(container.textContent).not.toContain("Oldest window");
});

it("uses a native oldest-only window and says why newest is unavailable", async () => {
  appAtomRegistry.set(
    page(undefined, "asc"),
    AsyncResult.success({ items: [event("Native oldest")], nextCursor: null }),
  );
  appAtomRegistry.set(
    page(),
    AsyncResult.success({ items: [event("Wrong direction")], nextCursor: null }),
  );
  await render("desc", ["asc"]);
  expect(container.textContent).toContain("Native oldest");
  expect(container.textContent).not.toContain("Wrong direction");
  expect(container.textContent).toContain("This tracker supports oldest first only.");
});

it("changes order from the menu and disables a direction the tracker cannot read", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<IssueOrderControl order="desc" onChange={onChange} />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const oldest = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent === "Oldest first",
  )!;
  await act(async () => oldest.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith("asc");
  await act(async () =>
    root.render(
      <IssueOrderControl key="restricted" order="asc" orders={["asc"]} onChange={onChange} />,
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const newest = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent === "Newest first",
  )!;
  expect(newest.getAttribute("aria-disabled")).toBe("true");
  await act(async () => newest.click());
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("This tracker supports oldest first only.");
});

it("reads known partial history without asking for a global direction or scanning more pages", async () => {
  const known = [
    { ...event("Known rename"), createdAt: "2026-10-14T00:00:00Z" },
    { ...event("Known close"), createdAt: "2026-10-15T00:00:00Z" },
  ];
  appAtomRegistry.set(
    page(undefined, null),
    AsyncResult.success({ items: known, nextCursor: null, truncated: true }),
  );
  appAtomRegistry.set(
    page(),
    AsyncResult.success({ items: [event("Unsupported fallback")], nextCursor: null }),
  );
  historyRequests.mockClear();
  await render("desc", []);
  expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    expect.stringContaining("Known rename"),
    expect.stringContaining("Known close"),
  ]);
  expect(container.textContent).not.toContain("Unsupported fallback");
  expect(container.textContent).not.toContain("No history yet.");
  expect(container.textContent).toContain(
    "The shown events are incomplete. Their global order is unavailable.",
  );
  expect(container.textContent).not.toContain("Newest first");
  expect(container.textContent).not.toContain("Oldest first");
  expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
    "https://gitlab.example.test/group/repo/-/issues/1",
  );
  await render("asc", []);
  expect(container.textContent).toContain("Known rename");
  expect(container.textContent).toContain("Known close");
  const uniqueQueries = [
    ...new Set(historyRequests.mock.calls.map(([target]) => JSON.stringify(target))),
  ];
  expect(uniqueQueries).toEqual([JSON.stringify({ environmentId, input: reference })]);
  expect(observeHistory).not.toHaveBeenCalled();
  expect(retry()).toBeUndefined();
});

it("does not call an empty partial history complete when no global order is supported", async () => {
  appAtomRegistry.set(
    page(undefined, null),
    AsyncResult.success({ items: [], nextCursor: null, truncated: true }),
  );
  await render("desc", []);
  expect(container.textContent).toContain(
    "The shown events are incomplete. Their global order is unavailable.",
  );
  expect(container.textContent).not.toContain("No history yet.");
  expect(observeHistory).not.toHaveBeenCalled();
});

it("keeps partial history reads tied to the selected account", async () => {
  appAtomRegistry.set(
    page(undefined, null),
    AsyncResult.success({
      items: [event("First account partial")],
      nextCursor: null,
      truncated: true,
    }),
  );
  appAtomRegistry.set(
    page(undefined, null, "other-account"),
    AsyncResult.success({
      items: [event("Other account partial")],
      nextCursor: null,
      truncated: true,
    }),
  );
  await render("desc", []);
  expect(container.textContent).toContain("First account partial");
  await render("desc", [], "other-account");
  expect(container.textContent).toContain("Other account partial");
  expect(container.textContent).not.toContain("First account partial");
});

it("shows an empty truncated history as incomplete, not absent", async () => {
  appAtomRegistry.set(
    page(),
    AsyncResult.success({ items: [], nextCursor: null, truncated: true }),
  );
  await render();
  expect(container.textContent).not.toContain("No history yet.");
  expect(container.textContent).toContain("The tracker returned part of this list.");
  expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
    "https://gitlab.example.test/group/repo/-/issues/1",
  );
});

it("disables order selection when native reads have no supported direction", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(<IssueOrderControl order="desc" orders={[]} onChange={onChange} />),
  );
  const button = container.querySelector<HTMLButtonElement>("button")!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("Order unavailable");
  await act(async () => button.click());
  expect(onChange).not.toHaveBeenCalled();
});

it.each(["javascript:alert(1)", "/guessed/host/path"])(
  "keeps a bounded history host link inert for unsafe URLs: %s",
  async (url) => {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <IssueHistory environmentId={environmentId} reference={reference} orders={[]} url={url} />
        </RegistryContext.Provider>,
      ),
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain(
      "This tracker cannot read the full history through its API.",
    );
    expect(container.textContent).not.toContain("No history yet.");
  },
);
