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
  pullRequestEnvironment: { diff: (request: unknown) => request, filesViewed: () => "viewed" },
}));
vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => refresh }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => settings,
  useUpdateClientSettings: () => command,
}));
vi.mock("~/hooks/useLocalStorage", async () => {
  const { useState } = await import("react");
  return {
    useLocalStorage: (_key: string, initial: unknown) => useState(initial),
    getLocalStorageItem: () => null,
  };
});
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
import { DiffFileTree } from "../diffs/DiffFileTree";
import { EditableDiffCodeView } from "../diffs/EditableDiffCodeView";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

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
it.each([
  { state: "merged", isDraft: false, commit: null, readOnly: true },
  { state: "closed", isDraft: false, commit: null, readOnly: true },
  { state: "open", isDraft: false, commit: null, readOnly: false },
  { state: "open", isDraft: true, commit: null, readOnly: false },
  { state: "open", isDraft: false, commit: "historical", readOnly: true },
] as const)(
  "gates file edits for $state, draft=$isDraft, commit=$commit",
  async ({ state, isDraft, commit, readOnly }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    query.mockImplementation((request) => ({
      data: request
        ? {
            patch:
              "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
            truncated: false,
            nextCursor: null,
            omittedFileStats: [],
          }
        : null,
      error: null,
      isPending: false,
      refresh,
    }));
    await act(async () => {
      renderer = create(
        <PullRequestCodeTab
          environmentId={EnvironmentId.make("test")}
          reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
          detail={{
            ...detail,
            state,
            isDraft,
            headBranch: "feature",
            capabilities: { ...detail.capabilities, diff: true },
          }}
          selectedCommitOid={commit}
          onSelectedCommitChange={command}
          onRefresh={refresh}
        />,
      );
    });
    const target = renderer.root.findByType(EditableDiffCodeView).props.editing("file.ts");
    if (commit) expect(target).toBeNull();
    else expect(target).toMatchObject({ readOnly });
  },
);
afterEach(async () => {
  await act(async () => renderer?.unmount());
  settings.diffFilesCollapsed = false;
  query.mockClear();
  vi.unstubAllGlobals();
});

it.each(["closed", "merged"] as const)(
  "keeps the review draft but removes formal verdicts after a PR becomes %s",
  async (state) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    query.mockImplementation((request) => ({
      data: request
        ? { patch: "", truncated: false, nextCursor: null, omittedFileStats: [] }
        : null,
      error: null,
      isPending: false,
      refresh,
    }));
    const reference = {
      projectId: ProjectId.make("review-state"),
      repository: "owner/repo",
      number: 1,
    };
    const key = pullRequestReviewKey(reference);
    const pending = {
      id: "pending",
      path: "file.ts",
      position: { kind: "added", newLine: 1 },
      body: "Keep this draft",
    } as const;
    usePullRequestReviewStore.getState().clear(key);
    usePullRequestReviewStore.getState().addComment(key, pending);
    usePullRequestReviewStore.getState().setSummary(key, "Keep this summary");
    const render = (currentState: PullRequestDetailView["state"], isDraft = false) => (
      <PullRequestCodeTab
        environmentId={EnvironmentId.make("test")}
        reference={reference}
        detail={{
          ...detail,
          state: currentState,
          isDraft,
          capabilities: {
            ...detail.capabilities,
            review: {
              inlineComment: true,
              reply: true,
              resolve: true,
              verdicts: ["comment", "approve", "request-changes"],
            },
          },
          viewerPermissions: {
            ...detail.viewerPermissions,
            comment: true,
            verdicts: ["comment", "approve", "request-changes"],
          },
        }}
        selectedCommitOid={null}
        onSelectedCommitChange={command}
        onRefresh={refresh}
      />
    );
    await act(async () => {
      renderer = create(render("open"));
    });
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Review"))!
        .props.onClick(),
    );
    const labels = () =>
      renderer.root
        .findAllByType("button")
        .flatMap((button) =>
          button
            .findAllByType("span")
            .flatMap((span) => span.children.filter((child) => typeof child === "string")),
        );
    expect(labels()).toContain("Approve");
    expect(labels()).toContain("Request changes");
    await act(async () => renderer.update(render("open", true)));
    expect(labels()).toContain("Approve");
    await act(async () => renderer.update(render(state)));
    expect(labels()).not.toContain("Approve");
    expect(labels()).not.toContain("Request changes");
    expect(labels()).toContain("Comment");
    expect(usePullRequestReviewStore.getState().drafts[key]).toEqual([pending]);
    expect(usePullRequestReviewStore.getState().summaries[key]).toBe("Keep this summary");
  },
);

it.each(["complete", "error", "scope change"])(
  "folder viewing handles paged files: %s",
  async (outcome) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", new EventTarget());
    command.mockReset().mockResolvedValue({ _tag: "Success" });
    const pages = [["src/a.ts"], ["src/deep/b.ts", "src-other/c.ts"]].map((paths, index) => ({
      patch: paths
        .map(
          (path) =>
            `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${path}\n`,
        )
        .join(""),
      truncated: false,
      nextCursor: index === 0 ? "1" : null,
      omittedFileStats: [],
    }));
    const viewed = { files: [], truncated: false };
    let arrived = false;
    query.mockImplementation((request) => {
      const later = request !== "viewed" && request?.input.cursor === "1";
      return {
        data: request === "viewed" ? viewed : later ? (arrived ? pages[1] : null) : pages[0],
        error: later && arrived && outcome === "error" ? "Unavailable" : null,
        isPending: later && !arrived,
        refresh,
      };
    });
    const view = (commit: string | null = null) => (
      <PullRequestCodeTab
        environmentId={EnvironmentId.make("test")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        detail={{
          ...detail,
          commits: [{ oid: "new", messageHeadline: "New commit", committedDate: "2026-09-18" }],
          capabilities: { ...detail.capabilities, viewedFiles: "environment" },
        }}
        selectedCommitOid={commit}
        onSelectedCommitChange={command}
        onRefresh={refresh}
      />
    );
    await act(async () => {
      renderer = create(view());
    });
    await click("Show file tree");
    await act(async () => renderer.root.findByType(DiffFileTree).props.onSetViewed("src/", true));
    expect(command).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([request]) => request?.input?.cursor === "1")).toBe(true);
    arrived = true;
    await act(async () => renderer.update(view(outcome === "scope change" ? "new" : null)));
    if (outcome === "complete") {
      expect(renderer.root.findAllByType("pre").map((node) => node.children.join(""))).toEqual([
        "src-other/c.ts",
      ]);
    }
    await act(async () => renderer.unmount());
    if (outcome === "complete") {
      expect(command).toHaveBeenCalledExactlyOnceWith({
        environmentId: "test",
        input: {
          projectId: "project",
          repository: "owner/repo",
          number: 1,
          files: [
            { path: "src/a.ts", viewed: true },
            { path: "src/deep/b.ts", viewed: true },
          ],
        },
      });
    } else expect(command).not.toHaveBeenCalled();
  },
);

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
  query.mockImplementation((request: { input: { cursor?: string } } | null) => ({
    data: request ? pages[Number(request.input.cursor ?? 0)] : null,
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
  expect(query.mock.calls.every(([request]) => request?.input.cursor === undefined)).toBe(true);
  await click("Load more review files");
  expect(query.mock.calls.findLast(([request]) => request !== null)?.[0].input.cursor).toBe("1");
  expect(observers.size).toBe(0);
  expect(renderer.root.findByType("h2").children).toEqual(["two.ts"]);
  await click("Guided review");
  await act(async () => {
    for (const intersect of observers) intersect();
  });
  expect(query.mock.calls.findLast(([request]) => request !== null)?.[0].input.cursor).toBe("2");
});

it.each([false, true])(
  "guide page loading follows inserted files unless selected manually: %s",
  async (manual) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", new EventTarget());
    const pages = [["src/a.ts", "README.md"], ["src/b.ts"]].map((paths, index) => ({
      patch: paths
        .map(
          (path) =>
            `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${path === "README.md" ? 'import "./src/a";' : path}\n`,
        )
        .join(""),
      truncated: false,
      nextCursor: index === 0 ? "1" : null,
      omittedFileStats: [],
    }));
    let arrived = false;
    query.mockImplementation((request) => ({
      data: request ? (request.input.cursor ? (arrived ? pages[1] : null) : pages[0]) : null,
      error: null,
      isPending: Boolean(request?.input.cursor) && !arrived,
      refresh,
    }));
    const view = () => (
      <PullRequestCodeTab
        environmentId={EnvironmentId.make("test")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        detail={detail}
        selectedCommitOid={null}
        onSelectedCommitChange={command}
        onRefresh={refresh}
      />
    );
    await act(async () => {
      renderer = create(view());
    });
    await click("Show file tree");
    await click("Guided review");
    await click("Next review file");
    expect(renderer.root.findByType("h2").children).toEqual(["README.md"]);
    await click("Load more review files");
    if (manual) await click("Previous review file");
    arrived = true;
    await act(async () => renderer.update(view()));
    expect(renderer.root.findByType("h2").children).toEqual([manual ? "src/a.ts" : "src/b.ts"]);
  },
);

it.each([false, true])(
  "shows and guides both sides of a file type change, paged: %s",
  async (paged) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", new EventTarget());
    const deletion =
      "diff --git a/app.ts b/app.ts\ndeleted file mode 100644\n--- a/app.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
    const addition =
      "diff --git a/app.ts b/app.ts\nnew file mode 120000\n--- /dev/null\n+++ b/app.ts\n@@ -0,0 +1 @@\n+target.ts\n";
    const data = {
      patch: deletion + (paged ? "" : addition),
      truncated: false,
      nextCursor: paged ? "1" : null,
      omittedFileStats: [],
    };
    query.mockImplementation((request) => ({
      data: request
        ? request.input.cursor
          ? { ...data, patch: addition, nextCursor: null }
          : data
        : null,
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
      );
    });
    expect(renderer.root.findAllByType("pre")).toHaveLength(paged ? 1 : 2);
    await click("Show file tree");
    expect(renderer.root.findAllByType("pre")).toHaveLength(paged ? 1 : 2);
    expect(renderer.root.findByType(DiffFileTree).props.entries).toEqual([
      { path: "app.ts", status: paged ? "deleted" : "modified" },
    ]);
    await click("Guided review");
    expect(renderer.root.findByType("pre").children).toEqual([]);
    await click(paged ? "Load more review files" : "Next review file");
    expect(renderer.root.findByType("pre").children).toEqual(["target.ts"]);
  },
);

it("opens the guide file in each commit scope and keeps manual collapses within that scope", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings.diffFilesCollapsed = true;
  const pages = ["all", "commit"].map((contents) => ({
    patch: `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+${contents}\n`,
    truncated: false,
    nextCursor: null,
    omittedFileStats: [],
  }));
  query.mockImplementation((request: { input: { commit?: string } } | null) => ({
    data: request ? pages[request.input.commit ? 1 : 0] : null,
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

it("marks the guide file viewed, advances, and can reopen it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  command.mockResolvedValue({ _tag: "Success" });
  const files = ["one.ts", "two.ts"];
  query.mockImplementation((request) => ({
    data:
      request === "viewed"
        ? { files: [], truncated: false }
        : {
            patch: files
              .map(
                (path) =>
                  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${path}\n`,
              )
              .join(""),
            truncated: false,
            nextCursor: null,
            omittedFileStats: [],
          },
    error: null,
    isPending: false,
    refresh,
  }));
  await act(async () => {
    renderer = create(
      <PullRequestCodeTab
        environmentId={EnvironmentId.make("test")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        detail={{ ...detail, capabilities: { ...detail.capabilities, viewedFiles: "environment" } }}
        selectedCommitOid={null}
        onSelectedCommitChange={command}
        onRefresh={refresh}
      />,
    );
  });
  await click("Guided review");
  expect(renderer.root.findByType("h2").children).toEqual(["one.ts"]);
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Mark viewed & next"))!
      .props.onClick(),
  );
  expect(renderer.root.findByType("h2").children).toEqual(["two.ts"]);
  await click("Previous review file");
  expect(renderer.root.findAllByType("pre")).toHaveLength(1);
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Mark as not viewed"))!
      .props.onClick(),
  );
  expect(
    renderer.root
      .findAllByType("button")
      .some((button) => button.children.includes("Mark viewed & next")),
  ).toBe(true);
  await act(async () => renderer.unmount());
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ files: [{ path: "one.ts", viewed: false }] }),
    }),
  );
});

it("keeps a reply draft when the off-diff conversation list is closed and reopened", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  const page = {
    patch:
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false,
    nextCursor: null,
    omittedFileStats: [],
  };
  query.mockImplementation((request) => ({
    data: request === null ? null : request === "viewed" ? { files: [], truncated: false } : page,
    error: null,
    isPending: false,
    refresh,
  }));
  await act(async () => {
    renderer = create(
      <PullRequestCodeTab
        environmentId={EnvironmentId.make("test")}
        reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
        detail={{
          ...detail,
          workspaceRoot: "/workspace",
          capabilities: {
            ...detail.capabilities,
            review: { ...detail.capabilities.review, reply: true },
          },
          viewerPermissions: { ...detail.viewerPermissions, comment: true },
          reviewThreads: [
            {
              id: "orphan",
              path: null,
              line: null,
              side: "right",
              isResolved: false,
              isOutdated: false,
              comments: [],
            },
          ],
        }}
        selectedCommitOid={null}
        onSelectedCommitChange={command}
        onRefresh={refresh}
      />,
    );
  });
  const toggle = () => {
    const button = renderer.root
      .findAllByType("button")
      .find((node) => typeof node.props["aria-expanded"] === "boolean")!;
    act(() => button.props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }));
  };
  toggle();
  act(() =>
    renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Reply…"))!
      .props.onClick(),
  );
  act(() =>
    renderer.root.findByType("textarea").props.onChange({
      target: { value: "Keep this draft" },
      currentTarget: { value: "Keep this draft" },
      nativeEvent: {},
    }),
  );
  toggle();
  toggle();
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this draft");
});
