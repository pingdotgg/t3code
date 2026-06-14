import {
  EnvironmentId,
  type EnvironmentApi,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { bakeoffThreadKeys, buildBakeoffViews, launchBakeoff, type Bakeoff } from "./bakeoffs";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "./environmentApi";
import type { AgentRun } from "./runs";
import type { Project } from "./types";

const bakeoff: Bakeoff = {
  id: "bakeoff-1",
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
  title: "Implement search",
  prompt: "Implement search",
  baseBranch: "main",
  createdAt: "2026-06-13T10:00:00.000Z",
  winnerThreadId: null,
  contestants: [
    {
      threadId: ThreadId.make("thread-a"),
      label: "Codex · gpt-5",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    },
    {
      threadId: ThreadId.make("thread-b"),
      label: "Claude · sonnet",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
    },
  ],
};

describe("bakeoffs", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.unstubAllGlobals();
  });

  it("groups matching agent runs while preserving contestants that have not appeared yet", () => {
    const run = {
      thread: {
        id: ThreadId.make("thread-a"),
        environmentId: EnvironmentId.make("env-1"),
      },
    } as AgentRun;

    const views = buildBakeoffViews([bakeoff], [run]);

    expect(views[0]?.contestants[0]?.run).toBe(run);
    expect(views[0]?.contestants[1]?.run).toBeNull();
  });

  it("returns scoped thread keys for excluding contestants from ordinary runs", () => {
    expect([...bakeoffThreadKeys([bakeoff])]).toEqual(["env-1:thread-a", "env-1:thread-b"]);
  });

  it("launches every contestant from the same base branch in a distinct worktree", async () => {
    vi.stubGlobal("window", {});
    type DispatchCommand = EnvironmentApi["orchestration"]["dispatchCommand"];
    const dispatchedCommands: Array<Parameters<DispatchCommand>[0]> = [];
    const dispatchCommand: DispatchCommand = vi.fn(async (command) => {
      dispatchedCommands.push(command);
      return { sequence: 1 };
    });
    __setEnvironmentApiOverrideForTests(EnvironmentId.make("env-1"), {
      vcs: {
        listRefs: vi.fn(async () => ({
          refs: [
            {
              name: "feature/current",
              current: true,
              isDefault: false,
              worktreePath: null,
            },
            { name: "main", current: false, isDefault: true, worktreePath: null },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 2,
        })),
      },
      orchestration: { dispatchCommand },
    } as unknown as EnvironmentApi);
    const project = {
      id: ProjectId.make("project-1"),
      environmentId: EnvironmentId.make("env-1"),
      name: "more Code",
      cwd: "/repo",
      defaultModelSelection: null,
      scripts: [],
    } satisfies Project;

    const launched = await launchBakeoff({
      project,
      title: "Search bakeoff",
      prompt: "Implement search",
      contestants: bakeoff.contestants.map((contestant) => ({
        label: contestant.label,
        modelSelection: contestant.modelSelection,
      })),
    });

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    type DispatchedCommand = Parameters<DispatchCommand>[0];
    type TurnStartCommand = Extract<DispatchedCommand, { type: "thread.turn.start" }>;
    const turnCommands = dispatchedCommands.filter(
      (command): command is TurnStartCommand => command.type === "thread.turn.start",
    );
    expect(turnCommands.map((command) => command.bootstrap?.prepareWorktree?.baseBranch)).toEqual([
      "feature/current",
      "feature/current",
    ]);
    expect(new Set(turnCommands.map((command) => command.threadId)).size).toBe(2);
    expect(
      new Set(turnCommands.map((command) => command.bootstrap?.prepareWorktree?.branch)).size,
    ).toBe(2);
    expect(launched.contestants).toHaveLength(2);
  });
});
