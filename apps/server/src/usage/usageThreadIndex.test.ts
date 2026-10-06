import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  claudeSubagentId,
  EMPTY_ATTRIBUTION,
  type UsageAttributionIndex,
  type UsageSessionSource,
  UsageThreadIndex,
} from "./usageThreadIndex.ts";

const parentThread = ThreadId.make("thread-parent");
const childThread = ThreadId.make("thread-child");
const agentThread = ThreadId.make("thread-agent");
const app = ProjectId.make("project-app");
const nested = ProjectId.make("project-app-docs");

const attribution: UsageAttributionIndex = {
  nativeThreads: new Map([
    ["claudeAgent\u0000parent-session", { threadId: parentThread, instanceId: "claude-work" }],
    ["codex\u0000child-session", { threadId: childThread, instanceId: null }],
  ]),
  nativeSubagents: new Map([
    ["claudeAgent\u0000agent-1", { threadId: agentThread, instanceId: null }],
  ]),
  threads: new Map([
    [parentThread, { projectId: app, title: "Ship it", parentThreadId: null }],
    [childThread, { projectId: app, title: "Review", parentThreadId: parentThread }],
    [agentThread, { projectId: app, title: "Explore", parentThreadId: parentThread }],
  ]),
  projects: [
    { projectId: app, title: "app", workspaceRoot: "/work/app", deleted: false },
    { projectId: nested, title: "", workspaceRoot: "/work/app/docs/", deleted: false },
  ],
};

const source = (overrides: Partial<UsageSessionSource>): UsageSessionSource => ({
  provider: "claude",
  sessionId: "parent-session",
  cwd: null,
  agentId: null,
  label: null,
  instanceId: null,
  ...overrides,
});

describe("UsageThreadIndex", () => {
  it("nests a delegated child thread under the thread that started it", () => {
    const index = new UsageThreadIndex(attribution);
    const child = index.groupFor(
      source({ provider: "codex", sessionId: "child-session", instanceId: "codex" }),
    );
    const { threads } = index.finish();

    const childThread = threads[child.thread!]!;
    expect(childThread.title).toBe("Review");
    expect(threads[childThread.parent!]).toMatchObject({
      threadId: parentThread,
      title: "Ship it",
    });
    // The T3 record names no account, so the directory's sole account applies.
    expect(child.instanceId).toBe("codex");
  });

  it("puts a provider sub-agent on the T3 thread it ran as, or under its session", () => {
    const index = new UsageThreadIndex(attribution);
    const known = index.groupFor(source({ agentId: "agent-1" }));
    const unknown = index.groupFor(source({ agentId: "agent-2", label: "Run tests" }));
    const parent = index.groupFor(source({}));
    const { threads } = index.finish();

    expect(threads[known.thread!]).toMatchObject({ threadId: agentThread, parent: parent.thread });
    expect(threads[unknown.thread!]).toEqual({
      key: "agent:claude:parent-session:agent-2",
      title: "Run tests",
      projectId: app,
      parent: parent.thread,
      subagent: true,
      located: true,
    });
    expect(known.instanceId).toBe("claude-work");
    expect(unknown.instanceId).toBe("claude-work");
  });

  it("places sessions from outside T3 by folder, deepest project first", () => {
    const index = new UsageThreadIndex(attribution);
    const docs = index.groupFor(source({ sessionId: "cli-1", cwd: "/work/app/docs/guide" }));
    const app = index.groupFor(source({ sessionId: "cli-2", cwd: "/work/app" }));
    const sibling = index.groupFor(source({ sessionId: "cli-3", cwd: "/work/application" }));
    const unknown = index.groupFor(source({ sessionId: "cli-4" }));
    const { threads, projects } = index.finish();

    expect(threads[docs.thread!]?.projectId).toBe(nested);
    expect(threads[app.thread!]?.projectId).toBe(ProjectId.make("project-app"));
    expect(threads[sibling.thread!]).toEqual({ key: "session:claude:cli-3", located: true });
    expect(threads[unknown.thread!]).toEqual({ key: "session:claude:cli-4", located: false });
    // A blank project title falls back to its folder name.
    expect(projects).toContainEqual({ projectId: nested, title: "docs" });
  });

  it("gives a folder to a live project over a deleted one at the same root", () => {
    const old = ProjectId.make("old");
    const index = new UsageThreadIndex({
      ...EMPTY_ATTRIBUTION,
      projects: [
        { projectId: old, title: "app", workspaceRoot: "/work/app", deleted: true },
        { projectId: app, title: "app", workspaceRoot: "/work/app", deleted: false },
        {
          projectId: ProjectId.make("gone"),
          title: "gone",
          workspaceRoot: "/work/gone",
          deleted: true,
        },
      ],
    });
    const live = index.groupFor(source({ sessionId: "a", cwd: "/work/app/src" }));
    const gone = index.groupFor(source({ sessionId: "b", cwd: "/work/gone" }));
    const { threads } = index.finish();
    expect(threads[live.thread!]?.projectId).toBe(app);
    // A deleted project still claims a folder no live project has.
    expect(threads[gone.thread!]?.projectId).toBe(ProjectId.make("gone"));
  });

  it("matches Windows folders regardless of letter case and slash", () => {
    const win = ProjectId.make("win");
    const index = new UsageThreadIndex({
      ...EMPTY_ATTRIBUTION,
      projects: [
        { projectId: win, title: "app", workspaceRoot: "C:\\Work\\App\\", deleted: false },
      ],
    });
    const group = index.groupFor(source({ sessionId: "w", cwd: "c:/work/app/src" }));
    const unc = new UsageThreadIndex({
      ...EMPTY_ATTRIBUTION,
      projects: [
        { projectId: win, title: "app", workspaceRoot: "\\\\Server\\Share\\App", deleted: false },
      ],
    });
    const shared = unc.groupFor(source({ sessionId: "u", cwd: "\\\\server\\share\\app\\lib" }));
    expect(index.finish().threads[group.thread!]?.projectId).toBe(win);
    expect(unc.finish().threads[shared.thread!]?.projectId).toBe(win);
  });

  it("lets a project rooted at / claim every folder no deeper project does", () => {
    const everything = ProjectId.make("root");
    const index = new UsageThreadIndex({
      ...EMPTY_ATTRIBUTION,
      projects: [{ projectId: everything, title: "root", workspaceRoot: "/", deleted: false }],
    });
    const group = index.groupFor(source({ sessionId: "s", cwd: "/work/app" }));
    expect(index.finish().threads[group.thread!]?.projectId).toBe(everything);
  });

  it("stops at a lineage loop instead of recursing forever", () => {
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    const index = new UsageThreadIndex({
      ...EMPTY_ATTRIBUTION,
      nativeThreads: new Map([["claudeAgent\u0000s", { threadId: a, instanceId: null }]]),
      threads: new Map([
        [a, { projectId: app, title: "A", parentThreadId: b }],
        [b, { projectId: app, title: "B", parentThreadId: a }],
      ]),
    });
    const group = index.groupFor(source({ sessionId: "s" }));
    const { threads } = index.finish();

    expect(threads).toHaveLength(2);
    expect(threads[group.thread!]?.title).toBe("A");
    expect(threads[threads[group.thread!]!.parent!]).not.toHaveProperty("parent");
  });

  it("leaves providers T3 cannot match without a thread", () => {
    const index = new UsageThreadIndex(attribution);
    expect(index.groupFor(source({ provider: "cursor", sessionId: "c" }))).toEqual({});
  });
});

describe("claudeSubagentId", () => {
  it("reads the agent id from a sub-agent transcript path", () => {
    expect(claudeSubagentId("/h/projects/p/s/subagents/agent-a1b2.jsonl")).toBe("a1b2");
    expect(claudeSubagentId("/h/projects/p/s.jsonl")).toBeNull();
  });
});
