// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  issueSourceKey,
  ProjectId,
  type IssueListEntry,
  type IssueListInput,
  type IssueListResult,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { Route, type IssuesSearch } from "./_chat.issues";

const mocks = vi.hoisted(() => ({
  search: { involvement: "all", state: "open" } as IssuesSearch,
  list: (_input: IssueListInput): IssueListResult | null => null,
  invalidate: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: object) => ({
    options,
    fullPath: "/issues",
    useSearch: () => mocks.search,
  }),
  useNavigate: () => vi.fn(),
  useCanGoBack: () => false,
  useRouter: () => ({ state: { matches: [] } }),
}));
vi.mock("../state/issues", () => ({
  issueEnvironment: {
    list: ({ input }: { input: IssueListInput }) => ({ input }),
    detail: () => null,
    invalidate: {},
    create: { permissionAtom: () => Atom.make(true) },
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.invalidate }));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => primaryEnvironment,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => projects,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  usePrimarySettings: () => undefined,
}));
vi.mock("../state/query", async (original) => {
  const { useReducer } = await import("react");
  return {
    ...(await original<typeof import("../state/query")>()),
    useEnvironmentQuery: (atom: { input?: IssueListInput } | null) => {
      const [, rerender] = useReducer((tick: number) => tick + 1, 0);
      const input = atom?.input;
      const held = answer(input);
      return input === undefined
        ? held
        : {
            ...held,
            refresh: () => {
              answers.set(JSON.stringify(input), { ...idle, data: mocks.list(input) });
              rerender();
            },
          };
    },
  };
});

const primaryEnvironment = {
  environmentId: "local",
  serverConfig: { environment: { capabilities: { issues: true } } },
};
const projects = [{ id: "p1", environmentId: "local", title: "Web", workspaceRoot: "/w" }];
const idle = { data: null, error: null, isPending: false, refresh: () => undefined };
const answers = new Map<string, { data: IssueListResult | null }>();
function answer(input: IssueListInput | undefined) {
  if (input === undefined) return idle;
  const key = JSON.stringify(input);
  if (!answers.has(key)) answers.set(key, { ...idle, data: mocks.list(input) });
  return answers.get(key);
}
const feedRequests = () =>
  [...answers.keys()]
    .map((key) => JSON.parse(key) as IssueListInput)
    .filter((input) => input.involvement === "all");

function issue(number: number, overrides: Partial<IssueListEntry> = {}): IssueListEntry {
  return {
    provider: "github",
    referenceStyle: "hash",
    host: "github.com",
    projectId: ProjectId.make("p1"),
    projectTitle: "Web",
    repository: "acme/web",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
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
    ...overrides,
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

const failure = {
  projectId: ProjectId.make("p1"),
  projectTitle: "Web",
  message: "acme/web could not be read.",
};
const retryButton = () =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === "Retry");

const observers: Array<{ active: boolean; reach: () => void }> = [];
const text = () => document.body.textContent ?? "";

beforeAll(async () => {
  await Route.options.component!.preload?.();
}, 60_000);

afterEach(() => {
  answers.clear();
  mocks.invalidate.mockClear();
  observers.length = 0;
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.innerHTML = "";
});

async function renderIssues() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly observer: (typeof observers)[number] = {
        active: true,
        reach: () => undefined,
      };
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
  const View = Route.options.component!;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<View />));
  return { unmount: () => act(async () => root.unmount()) };
}

const reachEnd = () =>
  act(async () => {
    for (const observer of observers.filter((candidate) => candidate.active)) observer.reach();
  });

describe("issues route", () => {
  it("shows an older authored label match when the recent feed has none", async () => {
    mocks.search = { involvement: "all", state: "open", label: "bug" };
    mocks.list = (input) =>
      result(
        input.involvement === "authored"
          ? [
              issue(777, {
                labels: [{ name: "bug", color: null }],
                updatedAt: "2026-01-01T00:00:00Z",
              }),
            ]
          : input.involvement === "all"
            ? [issue(1)]
            : [],
      );
    const { unmount } = await renderIssues();

    expect(text()).toContain("Issue 777");
    expect(text()).not.toContain("Issue 1");
    expect(text()).not.toContain("No issues");
    await unmount();
  });

  it("grows a truncated page without cursors up to the cap and then stops", async () => {
    mocks.search = { involvement: "all", state: "open", label: "bug" };
    mocks.list = (input) =>
      result(input.involvement === "all" ? [issue(1)] : [], {
        truncated: input.involvement === "all",
      });
    const { unmount } = await renderIssues();
    const loadMore = () =>
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Load more issues"),
      );

    expect(text()).toContain("No issues");
    for (let clicks = 0; loadMore() !== undefined; clicks += 1) {
      expect(clicks).toBeLessThan(10);
      await act(async () => loadMore()!.click());
    }
    expect(new Set(feedRequests().map((input) => input.limit))).toEqual(
      new Set([99, 198, 297, 396, 495, 500]),
    );
    await unmount();
  });

  it("keeps continuing other repositories after a cursor limit, then stops without a full page", async () => {
    mocks.search = { involvement: "all", state: "open" };
    const pages: Record<string, IssueListResult> = {
      null: result([issue(1), issue(2, { repository: "acme/api" })], {
        truncated: true,
        nextCursors: { web: "web-1", api: "api-1" },
      }),
      [JSON.stringify({ web: "web-1", api: "api-1" })]: result([issue(3)], {
        truncated: true,
        cursorLimitReached: true,
        nextCursors: { api: "api-2" },
      }),
      [JSON.stringify({ api: "api-2" })]: result([issue(4, { repository: "acme/api" })]),
    };
    mocks.list = (input) =>
      input.involvement === "all" ? pages[JSON.stringify(input.cursors ?? null)]! : result([]);
    const { unmount } = await renderIssues();

    await reachEnd();
    await reachEnd();
    const requested = feedRequests();
    await reachEnd();

    for (const number of [1, 2, 3, 4]) expect(text()).toContain(`Issue ${number}`);
    expect(text()).toContain("More issues remain on the host.");
    expect(feedRequests()).toEqual(requested);
    expect(requested.map((input) => input.cursors ?? null)).toEqual([
      null,
      { web: "web-1", api: "api-1" },
      { api: "api-2" },
    ]);
    await unmount();
  });

  it("warns that issues remain on the host when a cursor limit leaves no label matches", async () => {
    mocks.search = { involvement: "all", state: "open", label: "bug" };
    mocks.list = (input) =>
      result(input.involvement === "all" ? [issue(1)] : [], {
        truncated: input.involvement === "all",
        cursorLimitReached: input.involvement === "all",
      });
    const { unmount } = await renderIssues();
    await reachEnd();

    expect(text()).toContain("No issues");
    expect(text()).toContain("More issues remain on the host.");
    expect(text()).not.toContain("Load more issues");
    expect(feedRequests()).toHaveLength(1);
    await unmount();
  });

  it("shows a failed search over a readable workspace and retries the search", async () => {
    let failing = true;
    mocks.search = { involvement: "all", state: "open", q: "crash" };
    mocks.list = (input) =>
      input.involvement !== "all"
        ? result([])
        : input.query === undefined
          ? result([issue(1)])
          : failing
            ? result([], { errors: [failure] })
            : result([issue(2, { title: "Crash on save" })]);
    vi.useFakeTimers();
    const { unmount } = await renderIssues();
    await act(async () => vi.advanceTimersByTime(300));
    vi.useRealTimers();

    expect(text()).toContain("acme/web could not be read.");
    expect(text()).not.toContain("No issues");

    failing = false;
    await act(async () => retryButton()!.click());
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Crash on save");
    expect(text()).not.toContain("could not be read");
    await unmount();
  });

  it("keeps loaded rows when a continuation fails, stops paging, and retries that slice", async () => {
    let failing = true;
    mocks.search = { involvement: "all", state: "open" };
    mocks.list = (input) =>
      input.involvement !== "all"
        ? result([])
        : input.cursors === undefined
          ? result([issue(1)], { truncated: true, nextCursors: { web: "web-1" } })
          : failing
            ? result([], { errors: [failure] })
            : result([issue(2)]);
    const { unmount } = await renderIssues();

    await reachEnd();
    await reachEnd();
    expect(text()).toContain("Issue 1");
    expect(text()).toContain("acme/web could not be read.");
    expect(feedRequests().filter((input) => input.cursors !== undefined)).toHaveLength(1);

    failing = false;
    await act(async () => retryButton()!.click());
    expect(text()).toContain("Issue 1");
    expect(text()).toContain("Issue 2");
    expect(text()).not.toContain("could not be read");
    await unmount();
  });
});
