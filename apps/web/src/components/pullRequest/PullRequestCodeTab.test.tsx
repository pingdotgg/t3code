import type { CodeViewDiffItem } from "@pierre/diffs/react";
import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { query, command, refresh, settings } = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
  refresh: vi.fn(),
  settings: { diffLayout: "unified", diffFilesCollapsed: false, wordWrap: false },
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: query }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => command }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { diff: (request: unknown) => request },
}));
vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => refresh }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => settings,
  useUpdateClientSettings: () => command,
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: (_key: string, initial: unknown) => [initial, command],
}));
vi.mock("../diffs/EditableDiffCodeView", () => ({
  EditableDiffCodeView: ({
    items,
    renderHeaderPrefix,
    renderCodeViewFooter,
  }: {
    items: readonly CodeViewDiffItem[];
    renderHeaderPrefix: (item: CodeViewDiffItem) => ReactNode;
    renderCodeViewFooter: () => ReactNode;
  }) => (
    <>
      {items.map((item) => (
        <section key={item.id}>
          {renderHeaderPrefix(item)}
          {item.collapsed ? null : <pre>{item.fileDiff.additionLines.join("")}</pre>}
        </section>
      ))}
      {renderCodeViewFooter()}
    </>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: (props: ComponentProps<"button">) => <button {...props} />,
  DropdownMenuItem: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({ children }: { children: ReactNode }) => children,
  Toggle: ({
    pressed,
    onPressedChange,
    ...props
  }: ComponentProps<"button"> & {
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => <button {...props} onClick={() => onPressedChange?.(!pressed)} />,
}));

import PullRequestCodeTab from "./PullRequestCodeTab";

let renderer: ReactTestRenderer;
const detail = {
  body: "",
  number: 1,
  updatedAt: "2026-09-13",
  commits: [],
  reviewThreads: [],
  capabilities: { review: { inlineComment: false, reply: false, resolve: false, verdicts: [] } },
  viewerPermissions: { comment: false, resolve: false, verdicts: [] },
} as unknown as PullRequestDetailView;
const click = async (label: string) => {
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === label)!
      .props.onClick(new Event("click")),
  );
};
afterEach(async () => {
  await act(async () => renderer?.unmount());
  settings.diffFilesCollapsed = false;
  vi.unstubAllGlobals();
});

it("loads guide pages only on request and resumes scroll loading outside the guide", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers = new Set<() => void>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      intersect = () => this.callback([{ isIntersecting: true }]);
      observe() {
        observers.add(this.intersect);
      }
      disconnect() {
        observers.delete(this.intersect);
      }
    },
  );
  const pages = ["one.ts", "two.ts", "three.ts"].map((path, index) => ({
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    truncated: false,
    nextCursor: index === 2 ? null : String(index + 1),
    omittedFileStats: [],
  }));
  query.mockImplementation(({ input }: { input: { cursor?: string } }) => ({
    data: pages[Number(input.cursor ?? 0)],
    error: null,
    isPending: false,
    refresh,
  }));
  await act(async () => {
    renderer = create(
      <PullRequestCodeTab
        environmentId={EnvironmentId.make("test")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        detail={detail}
        selectedCommitOid={null}
        onSelectedCommitChange={command}
        onRefresh={refresh}
      />,
      { createNodeMock: () => ({}) },
    );
  });
  expect(observers.size).toBe(1);
  await click("Guided review");
  await act(async () => {
    for (const intersect of observers) intersect();
  });
  expect(query.mock.calls.every(([request]) => request.input.cursor === undefined)).toBe(true);
  await click("Load more review files");
  expect(query.mock.lastCall?.[0].input.cursor).toBe("1");
  expect(observers.size).toBe(0);
  await click("Next review file");
  expect(renderer.root.findByType("h2").children).toEqual(["two.ts"]);
  await click("Guided review");
  await act(async () => {
    for (const intersect of observers) intersect();
  });
  expect(query.mock.lastCall?.[0].input.cursor).toBe("2");
});

it("opens the guide file in each commit scope and keeps manual collapses within that scope", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings.diffFilesCollapsed = true;
  const pages = ["all", "commit"].map((contents) => ({
    patch: `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+${contents}\n`,
    truncated: false,
    nextCursor: null,
    omittedFileStats: [],
  }));
  query.mockImplementation(({ input }: { input: { commit?: string } }) => ({
    data: pages[input.commit ? 1 : 0],
    error: null,
    isPending: false,
    refresh,
  }));
  const view = (commit: string | null, actionPending = false) => (
    <PullRequestCodeTab
      environmentId={EnvironmentId.make("test")}
      reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
      detail={{
        ...detail,
        commits: [{ oid: "commit", messageHeadline: "Commit", committedDate: "2026-09-13" }],
      }}
      selectedCommitOid={commit}
      onSelectedCommitChange={command}
      onRefresh={refresh}
      actionPending={actionPending}
    />
  );
  await act(async () => {
    renderer = create(view(null));
  });
  expect(renderer.root.findAllByType("pre")).toHaveLength(0);
  await click("Guided review");
  expect(renderer.root.findByType("pre").children).toEqual(["all"]);
  await click("Collapse diff");
  expect(renderer.root.findAllByType("pre")).toHaveLength(0);
  await act(async () => renderer.update(view("commit")));
  expect(renderer.root.findByType("pre").children).toEqual(["commit"]);
  await click("Collapse all files");
  await act(async () => renderer.update(view("commit", true)));
  expect(renderer.root.findAllByType("pre")).toHaveLength(0);
  await act(async () => renderer.update(view(null)));
  expect(renderer.root.findByType("pre").children).toEqual(["all"]);
});
