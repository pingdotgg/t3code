import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shell: null as { projectId: string; worktreePath: string | null } | null,
  detail: null as { thread: { projectId: string } } | null,
  detailWorktreePath: null as string | null,
  projects: new Map<string, { workspaceRoot: string }>(),
}));

vi.mock("./entities", () => ({
  useQuietThreadShell: (ref: unknown) => (ref === null ? null : state.shell),
  useProject: (ref: { projectId: string } | null) =>
    ref === null ? null : (state.projects.get(ref.projectId) ?? null),
}));
vi.mock("./threads", async () => {
  const { some, none } = await import("effect/Option");
  return {
    useEnvironmentThread: (environmentId: unknown, threadId: unknown) => ({
      data:
        environmentId !== null && threadId !== null && state.detail ? some(state.detail) : none(),
    }),
  };
});
vi.mock("./use-thread-detail", () => ({
  useThreadWorktreePath: (ref: unknown) => (ref === null ? null : state.detailWorktreePath),
  useSelectedThreadWorktreePath: () => null,
}));
vi.mock("./use-thread-selection", () => ({ useThreadSelection: () => ({}) }));

const { useThreadCwd } = await import("./use-selected-thread-worktree");

const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function setup(input: Partial<Omit<typeof state, "projects">>) {
  Object.assign(state, { shell: null, detail: null, detailWorktreePath: null }, input);
  state.projects = new Map([[ProjectId.make("project"), { workspaceRoot: "/repo" }]]);
}

describe("useThreadCwd", () => {
  it("falls back to the project root from the loaded detail when the shell is missing", () => {
    setup({ detail: { thread: { projectId: "project" } } });
    expect(useThreadCwd(ref)).toBe("/repo");
  });

  it("prefers the thread worktree over the project root", () => {
    setup({ shell: { projectId: "project", worktreePath: "/repo/.worktrees/a" } });
    expect(useThreadCwd(ref)).toBe("/repo/.worktrees/a");
  });

  it("is null without a thread", () => {
    setup({ detail: { thread: { projectId: "project" } } });
    expect(useThreadCwd(null)).toBeNull();
  });
});
