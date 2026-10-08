import type { EnvironmentId, ThreadIssueLink } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { LIVE_REFRESH_IDLE_AFTER_MS, LIVE_REFRESH_INTERVAL_MS } from "~/hooks/useLiveRefresh";
import { ThreadIssueTrees } from "./ThreadIssueTrees";

const runtime = vi.hoisted(() => ({ current: null as { status: string } | null }));
const refreshes = vi.hoisted(() => new Map<string, number>());
const pending = vi.hoisted(() => new Set<string>());
const invalidate = vi.hoisted(() => vi.fn());
const served = vi.hoisted(() => new Map<string, unknown>());
const failed = vi.hoisted(() => new Set<string>());
const open = vi.hoisted(() => vi.fn());
const openInBrowser = vi.hoisted(() => vi.fn());
vi.mock("~/lib/openIssueLink", () => ({ openLinkInBrowser: openInBrowser }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => (runtime.current ? { runtime: runtime.current } : null),
}));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { detail: ({ input }: { input: unknown }) => input, invalidate },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => invalidate }));
vi.mock("~/state/query", async () => {
  const { useCallback } = await import("react");
  return {
    useEnvironmentQuery: ({ projectId }: { projectId: string }) => ({
      data: pending.has(projectId)
        ? null
        : served.has(projectId)
          ? served.get(projectId)
          : issues.find((issue) => issue.projectId === projectId),
      error: failed.has(projectId) ? "The environment request failed." : null,
      isPending: pending.has(projectId),
      refresh: useCallback(
        () => refreshes.set(projectId, (refreshes.get(projectId) ?? 0) + 1),
        [projectId],
      ),
    }),
  };
});

const issue = {
  provider: "github",
  repository: "acme/web",
  number: 7,
  title: "Public",
  url: "https://github.com/acme/web/issues/7",
  state: "open",
  projectId: "public",
} as ThreadIssueLink;
const issues = [
  issue,
  {
    ...issue,
    title: "Enterprise",
    url: "https://github.acme.test/acme/web/issues/7",
    projectId: "enterprise",
  },
  {
    provider: "linear",
    repository: "ENG",
    number: 3,
    title: "Linear",
    url: "https://linear.app/acme/issue/ENG-3/linear",
    state: "open",
    projectId: "linear",
  },
] as Array<ThreadIssueLink>;

let renderer: ReactTestRenderer | undefined;
let document: EventTarget & { visibilityState: string };
let start = 0;
beforeEach(() => {
  vi.useFakeTimers();
  start += 24 * 60 * 60_000;
  vi.setSystemTime(start);
  document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  runtime.current = null;
  refreshes.clear();
  pending.clear();
  served.clear();
  failed.clear();
  invalidate.mockClear();
  open.mockClear();
  openInBrowser.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(linked: ReadonlyArray<ThreadIssueLink> = issues) {
  act(() => {
    renderer = create(trees(linked));
  });
  refreshes.clear();
}

function trees(linked: ReadonlyArray<ThreadIssueLink> = issues, environment = "env") {
  return (
    <ThreadIssueTrees
      environmentId={environment as EnvironmentId}
      threadRef={null}
      linked={linked}
      projectFor={(candidate) => candidate.projectId ?? null}
      onOpen={open}
      onOpenPullRequest={() => {}}
      renderActions={(candidate) => <span data-url={candidate.url} />}
    />
  );
}

const treeLabels = () =>
  renderer!.root
    .findAll((node) => node.props.role === "tree")
    .map((node) => node.props["aria-label"]);
const counts = () =>
  Object.fromEntries(issues.map(({ projectId }) => [projectId, refreshes.get(projectId!) ?? 0]));
const each = (count: number) => ({ public: count, enterprise: count, linear: count });

it("keeps same-numbered issues on different hosts as separate trees with their own actions", () => {
  mount(issues.slice(0, 2));
  expect(treeLabels()).toEqual(["Public", "Enterprise"]);
  expect(
    renderer!.root
      .findAll((node) => node.type === "span" && node.props["data-url"])
      .map((node) => node.props["data-url"]),
  ).toEqual(issues.slice(0, 2).map((linked) => linked.url));
});

it("re-reads every tree on the live interval only while the window is showing and in use", () => {
  mount();
  expect(counts()).toEqual(each(0));

  act(() => vi.advanceTimersByTime(60_000));
  expect(counts()).toEqual(each(0));
  act(() => vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS - 60_000));
  expect(counts()).toEqual(each(1));

  document.visibilityState = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS * 3));
  expect(counts()).toEqual(each(1));

  document.visibilityState = "visible";
  act(() => document.dispatchEvent(new Event("pointerdown")));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(counts()).toEqual(each(2));

  act(() => vi.advanceTimersByTime(LIVE_REFRESH_IDLE_AFTER_MS + LIVE_REFRESH_INTERVAL_MS * 3));
  expect(counts()).toEqual(each(3));

  act(() => document.dispatchEvent(new Event("pointerdown")));
  expect(counts()).toEqual(each(4));
  expect(invalidate).not.toHaveBeenCalled();
});

it("leaves a tree alone while its first read is still pending", () => {
  pending.add("enterprise");
  mount();
  act(() => vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS));
  expect(counts()).toEqual({ public: 1, enterprise: 0, linear: 1 });
});

it("does not share a refresh schedule across environments", () => {
  act(() => {
    renderer = create(
      <>
        {trees(issues, "first")}
        {trees(issues, "second")}
      </>,
    );
  });
  refreshes.clear();
  act(() => vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS));
  expect(counts()).toEqual(each(2));
});

it("re-reads each tree once per finished run through the server cache", () => {
  runtime.current = { status: "running" };
  mount();
  for (const status of ["idle", "running", "idle", "running", "idle"]) {
    runtime.current = { status };
    act(() => renderer!.update(trees()));
  }
  expect(counts()).toEqual(each(3));
  expect(invalidate).not.toHaveBeenCalled();
});

it("shows a tree only while the tracker answers with the saved issue", () => {
  const linear = issues[2]!;
  served.set("linear", { ...linear, title: "Renamed", url: `${linear.url}-renamed?x=1` });
  mount([linear]);
  expect(treeLabels()).toEqual(["Renamed"]);
  act(() =>
    renderer!.root
      .find((node) => node.type === "button" && node.props["aria-current"])
      .props.onClick(),
  );
  expect(open).toHaveBeenCalledOnce();

  for (const answer of [
    { ...linear, title: "Other org", url: "https://linear.app/other/issue/ENG-3/linear" },
    { ...linear, provider: "github" },
    null,
  ]) {
    served.set("linear", answer);
    act(() => renderer!.update(trees([linear])));
    expect(treeLabels()).toEqual([]);
    act(() => renderer!.root.findByType("button").props.onClick());
  }
  expect(openInBrowser.mock.calls).toEqual([[linear.url], [linear.url], [linear.url]]);
  expect(open).toHaveBeenCalledOnce();

  pending.add("linear");
  act(() => renderer!.update(trees([linear])));
  expect(treeLabels()).toEqual([]);
  expect(renderer!.root.findAllByType("button")).toEqual([]);
});

it("opens the saved URL instead of a tree kept from before a failed refresh", () => {
  const linear = issues[2]!;
  mount([linear]);
  expect(treeLabels()).toEqual(["Linear"]);
  failed.add("linear");
  act(() => renderer!.update(trees([linear])));
  expect(treeLabels()).toEqual([]);
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(linear.url);
  expect(open).not.toHaveBeenCalled();
});
