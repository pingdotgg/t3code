// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  issueSourceKey,
  ProjectId,
  type IssueListEntry,
  type IssueListInput,
  type IssueListResult,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { IssuesPanel } from "./IssuesPanel";

const mocks = vi.hoisted(() => ({
  list: (_input: IssueListInput): IssueListResult => {
    throw new Error("unset");
  },
  invalidate: vi.fn(async () => undefined),
  refreshes: [] as Array<IssueListInput["cursors"] | null>,
}));

vi.mock("./IssueDetailPanel", () => ({
  IssueDetailPanel: ({ onActed }: { onActed?: () => void }) => (
    <>
      <button onClick={onActed}>Closed on host</button>
      <button>Refused by host</button>
    </>
  ),
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: {
    list: ({ input }: { input: IssueListInput }) => ({ input }),
    invalidate: {},
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.invalidate }));
vi.mock("~/state/query", async () => {
  const { useReducer } = await import("react");
  return {
    useEnvironmentQuery: ({ input }: { input: IssueListInput }) => {
      const [, rerender] = useReducer((tick: number) => tick + 1, 0);
      const key = JSON.stringify(input);
      if (!answers.has(key)) answers.set(key, { data: mocks.list(input) });
      return {
        data: answers.get(key)!.data,
        error: null,
        isPending: answers.get(key)!.pending === true,
        refresh: () => {
          mocks.refreshes.push(input.cursors ?? null);
          answers.set(key, { data: mocks.list(input) });
          rerender();
        },
      };
    },
  };
});

const answers = new Map<string, { data: IssueListResult; pending?: boolean }>();
const requests = () => [...answers.keys()].map((key) => JSON.parse(key) as IssueListInput);

function issue(number: number, repository = "acme/web"): IssueListEntry {
  return {
    provider: "github",
    referenceStyle: "hash",
    host: "github.com",
    projectId: ProjectId.make("p1"),
    projectTitle: "Web",
    repository,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${repository}/issues/${number}`,
    author: { login: "someone", name: null, avatarUrl: null },
    state: "open",
    stateReason: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    milestone: null,
    commentCount: 0,
  };
}

function result(
  entries: ReadonlyArray<IssueListEntry>,
  overrides: Partial<IssueListResult> = {},
): IssueListResult {
  return {
    viewers: { [issueSourceKey("github", "github.com")]: "me" },
    providers: [],
    entries,
    errors: [],
    truncated: false,
    nextCursors: {},
    ...overrides,
  };
}

const readFailure = {
  projectId: ProjectId.make("p1"),
  projectTitle: "Web",
  message: "acme/web could not be read.",
};

const observers: Array<{ active: boolean; reach: () => void }> = [];
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
const click = (label: string) => act(async () => button(label)!.click());
const reachEnd = () =>
  act(async () => {
    for (const observer of observers.filter((candidate) => candidate.active)) observer.reach();
  });

afterEach(() => {
  answers.clear();
  observers.length = 0;
  mocks.refreshes.length = 0;
  mocks.invalidate.mockClear();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function renderPanel() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly observer = { active: true, reach: () => undefined as void };
      constructor(callback: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) {
        this.observer.reach = () => callback([{ isIntersecting: true }]);
        observers.push(this.observer);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.observer.active = false;
      }
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  function Panel() {
    const [selected, setSelected] = useState<Parameters<typeof IssuesPanel>[0]["selected"]>(null);
    return (
      <IssuesPanel
        environmentId={EnvironmentId.make("local")}
        projectId={ProjectId.make("p1")}
        selected={selected}
        onSelect={setSelected}
        handoffTarget={{ kind: "new-thread" } as never}
        onStateChange={() => undefined}
        onOpenLinkedPullRequest={() => undefined}
      />
    );
  }
  await act(async () => root.render(<Panel />));
  return { unmount: () => act(async () => root.unmount()) };
}

describe("IssuesPanel", () => {
  it("keeps continuing other repositories after a cursor limit, then stops without a full page", async () => {
    const pages: Record<string, IssueListResult> = {
      null: result([issue(1), issue(2, "acme/api")], {
        truncated: true,
        nextCursors: { web: "web-1", api: "api-1" },
      }),
      [JSON.stringify({ web: "web-1", api: "api-1" })]: result([issue(901)], {
        truncated: true,
        cursorLimitReached: true,
        nextCursors: { api: "api-2" },
      }),
      [JSON.stringify({ api: "api-2" })]: result([issue(4, "acme/api")]),
    };
    mocks.list = (input) => pages[JSON.stringify(input.cursors ?? null)]!;
    const { unmount } = await renderPanel();

    await reachEnd();
    await reachEnd();
    const requested = requests();
    await reachEnd();

    for (const number of [1, 2, 901, 4]) expect(text()).toContain(`Issue ${number}`);
    expect(text()).toContain("More issues remain on the host.");
    expect(requests()).toEqual(requested);
    expect(requested.map((input) => [input.limit, input.cursors ?? null])).toEqual([
      [30, null],
      [30, { web: "web-1", api: "api-1" }],
      [30, { api: "api-2" }],
    ]);
    await unmount();
  });

  it("warns that issues remain on the host when a cursor limit leaves no rows", async () => {
    mocks.list = () => result([], { truncated: true, cursorLimitReached: true });
    const { unmount } = await renderPanel();
    await reachEnd();

    expect(text()).toContain("More issues remain on the host.");
    expect(button("Load more")).toBeUndefined();
    expect(requests()).toHaveLength(1);
    await unmount();
  });

  it("still grows a truncated page without cursors up to the ceiling", async () => {
    mocks.list = () => result([], { truncated: true });
    const { unmount } = await renderPanel();

    for (let clicks = 0; button("Load more") !== undefined; clicks += 1) {
      expect(clicks).toBeLessThan(20);
      await act(async () => button("Load more")!.click());
    }
    expect(requests().at(-1)?.limit).toBe(500);
    await unmount();
  });

  it("reports a provider failure instead of an empty repository, and retries from the host", async () => {
    let failing = true;
    mocks.list = () => (failing ? result([], { errors: [readFailure] }) : result([issue(1)]));
    const { unmount } = await renderPanel();

    expect(text()).toContain("acme/web could not be read.");
    expect(text()).not.toContain("This repository has no issues");

    failing = false;
    await act(async () => button("Retry")!.click());
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Issue 1");
    expect(text()).not.toContain("could not be read");
    await unmount();
  });

  it("keeps the rows it has when a continuation fails, stops paging, and retries that slice", async () => {
    let failing = true;
    mocks.list = (input) =>
      input.cursors === undefined
        ? result([issue(1)], { truncated: true, nextCursors: { web: "web-1" } })
        : failing
          ? result([], { errors: [readFailure] })
          : result([issue(2)]);
    const { unmount } = await renderPanel();

    await reachEnd();
    await reachEnd();
    expect(text()).toContain("Issue 1");
    expect(text()).toContain("acme/web could not be read.");
    expect(requests()).toHaveLength(2);

    failing = false;
    await act(async () => button("Retry")!.click());
    expect(mocks.refreshes).toEqual([{ web: "web-1" }]);
    expect(text()).toContain("Issue 1");
    expect(text()).toContain("Issue 2");
    expect(text()).not.toContain("could not be read");
    await unmount();
  });

  it("keeps paged rows across reading an issue without reading the list again", async () => {
    const pages: Record<string, IssueListResult> = {
      null: result([issue(1), issue(2)], { truncated: true, nextCursors: { web: "web-1" } }),
      [JSON.stringify({ web: "web-1" })]: result([issue(3)], {
        truncated: true,
        nextCursors: { web: "web-2" },
      }),
      [JSON.stringify({ web: "web-2" })]: result([issue(4)]),
    };
    mocks.list = (input) => pages[JSON.stringify(input.cursors ?? null)]!;
    const { unmount } = await renderPanel();
    await reachEnd();
    const requested = requests();

    await click("Issue 3");
    expect(text()).toContain("Closed on host");
    await reachEnd();
    await click("All issues");

    for (const number of [1, 2, 3]) expect(text()).toContain(`Issue ${number}`);
    expect(requests()).toEqual(requested);
    expect(mocks.refreshes).toEqual([]);

    await reachEnd();
    expect(text()).toContain("Issue 4");
    expect(requests().map((input) => input.cursors ?? null)).toEqual([
      null,
      { web: "web-1" },
      { web: "web-2" },
    ]);
    await unmount();
  });

  it("reads the list again after an action succeeds, and not after one fails", async () => {
    let closed = false;
    mocks.list = (input) =>
      input.cursors !== undefined
        ? result([issue(3)])
        : input.limit === 30
          ? result([issue(1), issue(2)], { truncated: true, nextCursors: { web: "web-1" } })
          : result(closed ? [issue(1), issue(2)] : [issue(1), issue(2), issue(3)]);
    const { unmount } = await renderPanel();
    await reachEnd();

    await click("Issue 3");
    await click("Refused by host");
    await click("All issues");
    for (const number of [1, 2, 3]) expect(text()).toContain(`Issue ${number}`);
    expect(requests()).toHaveLength(2);

    await click("Issue 3");
    closed = true;
    await click("Closed on host");
    await click("All issues");
    expect(text()).toContain("Issue 1");
    expect(text()).toContain("Issue 2");
    expect(text()).not.toContain("Issue 3");
    expect(requests()).toHaveLength(2);
    expect(mocks.refreshes).toEqual([null]);
    await unmount();
  });

  it("reads the first page again after an action on an unpaged list", async () => {
    let closed = false;
    mocks.list = () => result(closed ? [issue(1)] : [issue(1), issue(2)]);
    const { unmount } = await renderPanel();

    await click("Issue 2");
    closed = true;
    await click("Closed on host");
    await click("All issues");
    expect(text()).toContain("Issue 1");
    expect(text()).not.toContain("Issue 2");
    expect(mocks.refreshes).toEqual([null]);
    await unmount();
  });

  it("reads the list again when a read in flight at an action answers after it", async () => {
    let closed = false;
    mocks.list = () => result(closed ? [issue(1)] : [issue(1), issue(2)]);
    const { unmount } = await renderPanel();
    const [key] = [...answers.keys()];
    const before = answers.get(key!)!;
    answers.set(key!, { ...before, pending: true });

    await click("Issue 2");
    closed = true;
    await click("Closed on host");
    answers.set(key!, { data: before.data });
    await click("All issues");
    expect(text()).toContain("Issue 1");
    expect(text()).not.toContain("Issue 2");
    expect(mocks.refreshes).toEqual([null]);
    await unmount();
  });

  it("reads the list again when a paged read in flight at an action answers after it", async () => {
    let closed = false;
    mocks.list = (input) =>
      input.cursors !== undefined
        ? result([issue(3)])
        : result(closed ? [issue(1), issue(2)] : [issue(1), issue(2), issue(3)], {
            truncated: !closed,
            nextCursors: closed ? {} : { web: "web-1" },
          });
    const { unmount } = await renderPanel();
    await reachEnd();
    const [key] = [...answers.keys()];
    const before = answers.get(key!)!;
    answers.set(key!, { ...before, pending: true });

    await click("Issue 3");
    closed = true;
    await click("Closed on host");
    answers.set(key!, { data: before.data });
    await click("All issues");
    expect(text()).toContain("Issue 1");
    expect(text()).not.toContain("Issue 3");
    expect(mocks.refreshes).toEqual([null]);
    await unmount();
  });
});
