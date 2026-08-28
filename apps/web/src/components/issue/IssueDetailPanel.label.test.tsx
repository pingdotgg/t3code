import type { EnvironmentId, IssueActivity, IssueDetail } from "@t3tools/contracts";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({}) },
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: {
    detail: () => "detail",
    activity: () => "activity",
    commentsPage: "commentsPage",
    invalidate: "invalidate",
    runAction: "runAction",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "detail" ? detail : activity,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../sourceControl/ActivityUnavailableState", () => ({
  ActivityUnavailableState: () => null,
}));
vi.mock("../sourceControl/actorPresentation", () => ({
  SourceControlActorLabel: () => null,
  SourceControlMetaLine: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../sourceControl/DetailTabStrip", () => ({
  DetailTabStrip: ({ children }: { children?: ReactNode }) => (
    <div data-detail-tabs>{children}</div>
  ),
}));
vi.mock("../sourceControl/ListGhosts", () => ({
  DetailGhost: () => null,
  TimelineGhost: () => null,
}));
vi.mock("./IssueSummaryTab", () => ({ IssueSummaryTab: () => null }));
vi.mock("./IssueTimelineTab", () => ({ IssueTimelineTab: () => null }));
vi.mock("./IssuesUnavailableState", () => ({ IssuesUnavailableState: () => null }));
const detail: IssueDetail = {
  provider: "linear",
  capabilities: {
    comment: false,
    actions: [],
    closeReasons: [],
    create: false,
    issueTemplates: false,
    edit: false,
    labels: false,
    assignees: false,
    listLabelCandidates: false,
    listAssigneeCandidates: false,
    search: true,
    linkedPullRequests: false,
    timelineEvents: false,
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
    create: false,
  },
  projectId: "project-1" as IssueDetail["projectId"],
  projectTitle: "T3 Code",
  workspaceRoot: "/tmp/project",
  repository: "acme/project",
  number: 42,
  title: "A Linear issue",
  body: "",
  url: "https://linear.app/acme/issue/ABC-42",
  author: null,
  state: "open",
  stateReason: null,
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
  linkedPullRequests: [],
};

const activity: IssueActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  nextCommentsCursor: null,
  events: [],
};

import { IssueDetailPanel } from "./IssueDetailPanel";
import { DetailTabStrip } from "../sourceControl/DetailTabStrip";
import { Button } from "../ui/button";
import { Menu, MenuItem } from "../ui/menu";
import { TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function textContent(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textContent).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textContent(node.props.children) : "";
}

function renderPanel(chromeVariant?: "full" | "collapse") {
  hooks.beginRender();
  return IssueDetailPanel({
    environmentId: "environment-1" as EnvironmentId,
    reference: {
      projectId: "project-1" as IssueDetail["projectId"],
      repository: "acme/project",
      number: 42,
    },
    handoffTarget: { kind: "new-thread" },
    ...(chromeVariant ? { chromeVariant } : {}),
  });
}

function panelHeader(panel: ReturnType<typeof IssueDetailPanel>) {
  return Children.toArray(panel.props.children)[0] as ReactElement<{
    readonly children: ReactNode;
  }>;
}

describe("IssueDetailPanel provider labels", () => {
  it("matches the pull request header height and keeps the tab row stable", () => {
    hooks.reset();
    const panel = renderPanel("collapse");
    const header = panelHeader(panel);
    const headerChildren = Children.toArray(header.props.children);

    expect(renderToStaticMarkup(header)).toContain("h-7");
    expect(
      headerChildren.some((child) => isValidElement(child) && child.type === DetailTabStrip),
    ).toBe(true);
  });

  it("keeps the default full chrome expanded when content scrolls", () => {
    hooks.reset();
    const panel = renderPanel();
    const header = panelHeader(panel);
    const fold = visitElements(
      header,
      (element) =>
        typeof element.props.ref === "object" &&
        typeof element.props.className === "string" &&
        element.props.className.includes("translate-y-0 opacity-100 delay-50"),
    );
    expect(fold).not.toBeNull();
    (fold!.props.ref as { current: { scrollHeight: number } | null }).current = {
      scrollHeight: 64,
    };
    const content = Children.toArray(panel.props.children)[1] as ReactElement<{
      readonly onScrollCapture: (event: { target: HTMLElement }) => void;
    }>;
    content.props.onScrollCapture({
      target: {
        scrollTop: 128,
        parentElement: { hasAttribute: () => true },
      } as unknown as HTMLElement,
    });

    const markup = renderToStaticMarkup(panelHeader(renderPanel()));
    expect(markup.indexOf('aria-hidden="false"')).toBeLessThan(
      markup.indexOf('aria-hidden="true"'),
    );
  });

  it("renders Linear labels in the header, tooltips, menu, and aria attributes", () => {
    hooks.reset();
    const panel = renderPanel();
    const menu = visitElements(panel, (element) => element.type === Menu);
    expect(menu).not.toBeNull();

    const panelMarkup = renderToStaticMarkup(panel);
    const menuItem = visitElements(
      menu,
      (element) =>
        element.type === MenuItem && textContent(element.props.children).includes("Open on Linear"),
    );
    const solveTrigger = visitElements(
      panel,
      (element) =>
        element.type === TooltipTrigger && textContent(element.props.children).includes("Solve"),
    );
    const solveButton = visitElements(solveTrigger, (element) => element.type === Button);
    const solveTooltip = visitElements(
      panel,
      (element) =>
        element.type === TooltipPopup &&
        textContent(element.props.children) === "Opens a thread on this project holding the task",
    );
    const markup = renderToStaticMarkup(cloneElement(menu!, { open: true }));

    expect(panelMarkup).toContain('aria-label="Open on Linear"');
    expect(menuItem).not.toBeNull();
    expect(textContent(menuItem?.props.children)).toContain("Open on Linear");
    expect(solveButton).not.toBeNull();
    expect(solveButton?.props.title).toBeUndefined();
    expect(solveTooltip).not.toBeNull();
    // Base UI portals do not emit popup contents during SSR; the real open root still renders
    // here, while the MenuItem assertion above checks the child mounted in that root.
    expect(markup).toContain('aria-haspopup="menu"');
  });
});
