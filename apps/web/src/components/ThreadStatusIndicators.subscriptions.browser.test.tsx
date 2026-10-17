import { ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";

const state = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock(import("../state/vcs"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
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
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      status: (({ input }: { input: { cwd: string } }) => statuses(input.cwd)) as never,
    },
  };
});
vi.mock(import("../state/pullRequests"), async (importOriginal) => {
  const original = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
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
    linkedPullRequestDetailAtom: (({ input }: { input: { number: number } }) =>
      summaries(input.number)) as never,
  };
});
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The lease overscans 160px around a 20px viewport, a 340px band. With 45px rows the band
// covers exactly 8 rows at each scroll position below.
const ROW_HEIGHT = 45;
const SPACER = 1000;

it("leases only visible palette results while retaining observed and cached PR badges", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  state.queries.length = 0;
  const viewport = () =>
    container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const scrollTo = async (top: number) => {
    await act(async () => {
      viewport().scrollTop = top;
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
    });
  };
  const badgeCount = () =>
    [...container.querySelectorAll("[aria-label]")].filter((node) =>
      node.getAttribute("aria-label")!.startsWith("PR #"),
    ).length;
  try {
    await act(async () =>
      root.render(
        <AppAtomRegistryProvider>
          <div data-slot="scroll-area-viewport" style={{ height: 20, overflowY: "auto" }}>
            <div style={{ height: SPACER }} />
            {threads.map((thread, index) => (
              <div key={thread.id} style={{ height: ROW_HEIGHT, overflow: "hidden" }}>
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
              </div>
            ))}
          </div>
        </AppAtomRegistryProvider>,
      ),
    );
    await scrollTo(0);
    expect(state.queries).toEqual([]);
    expect(badgeCount()).toBe(1);

    // Band [1000, 1340]: rows 0..7.
    await scrollTo(SPACER + 160);
    expect(state.queries).toHaveLength(8);
    expect(state.queries.filter((key) => key.startsWith("vcs:"))).toHaveLength(4);
    expect(state.queries.filter((key) => key.startsWith("pr:"))).toHaveLength(4);
    expect(badgeCount()).toBe(9);

    // Band [1370, 1710]: rows 8..15.
    await scrollTo(SPACER + 8 * ROW_HEIGHT + 10 + 160);
    expect(state.queries).toHaveLength(16);
    expect(badgeCount()).toBe(17);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
