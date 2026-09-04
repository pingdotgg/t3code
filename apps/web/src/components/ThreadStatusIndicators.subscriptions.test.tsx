import { ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";

const state = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock("../state/entities", () => ({ useProject: () => null }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => undefined }));
vi.mock("../state/vcs", async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  const statuses = Atom.family((cwd: string) =>
    Atom.make(() => {
      state.queries.push(`vcs:${cwd}`);
      return AsyncResult.success({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature/test",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: {
          number: 42,
          title: "Observed worktree PR",
          url: "https://github.com/example/repo/pull/42",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      } satisfies VcsStatusResult);
    }),
  );
  return {
    vcsEnvironment: { status: ({ input }: { input: { cwd: string } }) => statuses(input.cwd) },
  };
});
vi.mock("../state/pullRequests", async (importOriginal) => {
  const original = await importOriginal<typeof import("../state/pullRequests")>();
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  const { ProjectId } = await import("@t3tools/contracts");
  const summaries = Atom.family((number: number) =>
    Atom.make(() => {
      state.queries.push(`pr:${number}`);
      return AsyncResult.success({
        provider: "github" as const,
        projectId: ProjectId.make("project-test"),
        repository: "example/repo",
        number,
        title: "Observed linked PR",
        url: `https://github.com/example/repo/pull/${number}`,
        state: "open" as const,
        headBranch: "feature/test",
        baseBranch: "main",
        updatedAt: "2026-09-04T00:00:00.000Z",
      });
    }),
  );
  return {
    ...original,
    linkedPullRequestDetailAtom: ({ input }: { input: { number: number } }) =>
      summaries(input.number),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      return isValidElement(render) ? cloneElement(render, undefined, children) : children;
    },
    TooltipPopup: () => null,
  };
});

import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("leases only visible palette results while retaining observed and cached PR badges", async () => {
  const observers: Array<{ setVisible: (visible: boolean) => void }> = [];
  const scrollRoot = {};
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) {
        observers.push({ setVisible: (visible) => callback([{ isIntersecting: visible }]) });
      }
      observe() {}
      disconnect() {}
    },
  );
  const threads = Array.from({ length: 128 }, (_, index) =>
    makeThreadFixture({
      id: ThreadId.make(`palette-thread-${index}`),
      branch: "feature/test",
      worktreePath: `/test/worktree-${index}`,
      linkedPullRequest:
        index % 2 === 0
          ? null
          : {
              projectId: ProjectId.make("project-test"),
              repository: "example/repo",
              number: index,
              url: `https://github.com/example/repo/pull/${index}`,
            },
    }),
  );
  let renderer: ReactTestRenderer | undefined;
  state.queries.length = 0;
  try {
    await act(async () => {
      renderer = create(
        <AppAtomRegistryProvider>
          {threads.map((thread, index) => (
            <span key={thread.id}>
              <ThreadRowLeadingStatus
                thread={thread}
                snapshot={
                  index === 126
                    ? {
                        branch: "feature/test",
                        sourceControlProvider: undefined,
                        pr: {
                          number: 126,
                          title: "Cached badge",
                          url: "https://github.com/example/repo/pull/126",
                          baseRef: "main",
                          headRef: "feature/test",
                          state: "open",
                        },
                      }
                    : undefined
                }
              />
              {thread.title}
            </span>
          ))}
        </AppAtomRegistryProvider>,
        { createNodeMock: () => ({ parentElement: { closest: () => scrollRoot } }) },
      );
    });
    const mounted = renderer!;
    const badgeCount = () =>
      mounted.root.findAll(
        (node) => node.type === "span" && String(node.props["aria-label"] ?? "").startsWith("PR #"),
      ).length;
    expect(observers).toHaveLength(128);
    expect(state.queries).toEqual([]);
    expect(badgeCount()).toBe(1);

    await act(async () => {
      for (const observer of observers.slice(0, 8)) observer.setVisible(true);
    });
    expect(state.queries).toHaveLength(8);
    expect(state.queries.filter((key) => key.startsWith("vcs:"))).toHaveLength(4);
    expect(state.queries.filter((key) => key.startsWith("pr:"))).toHaveLength(4);
    expect(badgeCount()).toBe(9);

    await act(async () => {
      for (const observer of observers.slice(0, 8)) observer.setVisible(false);
      for (const observer of observers.slice(8, 16)) observer.setVisible(true);
    });
    expect(state.queries).toHaveLength(16);
    expect(badgeCount()).toBe(17);
  } finally {
    await act(async () => renderer?.unmount());
  }
});
