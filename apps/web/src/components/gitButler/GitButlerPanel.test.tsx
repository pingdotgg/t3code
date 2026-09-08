import type { GitButlerWorkspaceStatus } from "@t3tools/contracts";
import { act } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderText, setupReactTestRenderer } from "~/test/reactRenderer";

import { GitButlerPanelView } from "./GitButlerPanel";
import { GitButlerPanelContent } from "./GitButlerPanelContent";
import { useGitButlerRepositoryStatusRefresh } from "./useGitButlerRepositoryStatusRefresh";

setupReactTestRenderer();

const readyStatus: Extract<GitButlerWorkspaceStatus, { status: "ready" }> = {
  status: "ready",
  version: "0.22.3",
  unassignedChanges: [{ filePath: "src/unassigned.ts", changeType: "modified" }],
  conflictedFiles: ["src/conflict.ts"],
  stacks: [
    {
      id: "stack-1",
      assignedChanges: [{ filePath: "src/owned.ts", changeType: "modified" }],
      branches: [
        {
          name: "feature/stacked-child",
          branchStatus: "completelyUnpushed",
          reviewId: "(#42)",
          reviewNumber: 42,
          reviewStatus: "passing",
          commits: [
            {
              commitId: "abc123456789",
              createdAt: "2026-09-08T12:00:00Z",
              message: "fix: resolve conflict",
              authorName: "Alice",
              conflicted: true,
              reviewId: "review-42",
              changes: [{ filePath: "src/conflict.ts", changeType: "modified" }],
            },
          ],
          upstreamCommits: [],
        },
      ],
    },
  ],
  mergeBaseCommitId: "base123456789",
  upstreamBehind: 2,
  upstreamLastFetched: "2026-09-08T13:00:00Z",
};

describe("GitButlerPanelContent", () => {
  it("renders stacked branches, file ownership, conflicts, and reviews", () => {
    const text = renderText(<GitButlerPanelContent status={readyStatus} />);

    expect(text).toContain("Stack 1");
    expect(text).toContain("feature/stacked-child");
    expect(text).toContain("src/unassigned.ts");
    expect(text).toContain("src/owned.ts");
    expect(text).toContain("src/conflict.ts");
    expect(text).toContain("Conflicted files");
    expect(text).toContain("Review (#42)");
    expect(text).toContain("CI passing");
    expect(text).toContain("2 behind upstream");
  });

  it("opens files and preserves collapsed branch stacks across status refreshes", () => {
    const onOpenFile = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<GitButlerPanelContent status={readyStatus} onOpenFile={onOpenFile} />);
    });

    const fileButton = renderer.root.findByProps({ "aria-label": "Open src/owned.ts" });
    act(() => fileButton.props.onClick());
    expect(onOpenFile).toHaveBeenCalledWith("src/owned.ts");

    const stackToggle = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Toggle Stack 1",
    );
    expect(stackToggle.props["aria-expanded"]).toBe(true);
    act(() => stackToggle.props.onClick({ nativeEvent: new Event("click") }));
    expect(stackToggle.props["aria-expanded"]).toBe(false);

    act(() => {
      renderer.update(
        <GitButlerPanelContent
          status={{
            ...readyStatus,
            stacks: readyStatus.stacks.map((stack) => ({ ...stack, id: "refreshed-stack-id" })),
          }}
          onOpenFile={onOpenFile}
        />,
      );
    });
    const refreshedToggle = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Toggle Stack 1",
    );
    expect(refreshedToggle.props["aria-expanded"]).toBe(false);

    act(() => renderer.unmount());
  });

  it("renders a clean configured workspace", () => {
    const text = renderText(
      <GitButlerPanelContent
        status={{
          ...readyStatus,
          unassignedChanges: [],
          conflictedFiles: [],
          stacks: [],
          upstreamBehind: 0,
        }}
      />,
    );

    expect(text).toContain("No GitButler branches or changes");
    expect(text).toContain("Up to date with upstream");
  });

  it("renders an unknown label for an invalid upstream timestamp", () => {
    const text = renderText(
      <GitButlerPanelContent
        status={{ ...readyStatus, upstreamLastFetched: "invalid-timestamp" }}
      />,
    );

    expect(text).toContain("Fetched unknown");
  });

  it("bounds large workspace rendering and reports omitted rows", () => {
    const text = renderText(
      <GitButlerPanelContent
        status={{
          ...readyStatus,
          unassignedChanges: Array.from({ length: 60 }, (_, index) => ({
            filePath: `src/file-${index}.ts`,
            changeType: "modified" as const,
          })),
          stacks: Array.from({ length: 11 }, (_, index) => ({
            id: `stack-${index}`,
            assignedChanges: [],
            branches: [],
          })),
        }}
      />,
    );

    expect(text).toContain("10 more files not shown.");
    expect(text).toContain("1 more stacks not shown.");
    expect(text).not.toContain("src/file-50.ts");
  });

  it("keeps cached data visible when a refresh fails", () => {
    const text = renderText(
      <GitButlerPanelView
        query={{
          data: readyStatus,
          error: "Connection lost",
          isPending: false,
          isSuccess: true,
          refresh: () => undefined,
        }}
      />,
    );

    expect(text).toContain("Refresh failed");
    expect(text).toContain("Showing the last available workspace state");
    expect(text).toContain("feature/stacked-child");
  });

  it.each([
    [
      {
        status: "missing",
        minimumVersion: "0.22.3",
        installHint: "Install GitButler on this server.",
      },
      "GitButler is not installed",
    ],
    [
      {
        status: "incompatible",
        version: "0.21.9",
        minimumVersion: "0.22.3",
        detail: "GitButler 0.22.3 or newer is required.",
      },
      "GitButler needs an update",
    ],
    [
      { status: "notConfigured", detail: "Open this repository in GitButler first." },
      "Workspace not configured",
    ],
    [
      { status: "error", detail: "GitButler returned malformed data." },
      "GitButler status unavailable",
    ],
  ] satisfies ReadonlyArray<readonly [GitButlerWorkspaceStatus, string]>)(
    "renders the %s state",
    (status, expected) => {
      const text = renderText(<GitButlerPanelContent status={status} />);
      expect(text).toContain(expected);
    },
  );
});

describe("GitButler workspace refresh", () => {
  function RefreshHarness({
    repositoryStatus,
    refresh,
  }: {
    readonly repositoryStatus: object | null;
    readonly refresh: () => void;
  }) {
    useGitButlerRepositoryStatusRefresh({ repositoryStatus, refresh });
    return null;
  }

  it("refreshes after the mounted repository status changes", () => {
    const refresh = vi.fn();
    const firstStatus = {};
    const secondStatus = {};
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<RefreshHarness repositoryStatus={firstStatus} refresh={refresh} />);
    });

    act(() => {
      renderer.update(<RefreshHarness repositoryStatus={secondStatus} refresh={refresh} />);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
