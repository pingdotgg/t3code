import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import {
  assignAgentSections,
  childThreadsByParent,
  parseRouterJobTag,
  routerJobTagOfMessages,
  threadBreadcrumbLinks,
  threadShellStatus,
  toggleExpandedThread,
  type RouterJobTag,
} from "./AgentThreadTree.logic";

const PLANNER = "7b0736c2-3dec-4adb-aa18-6d93d15db108";

function agent(id: string, status: RuntimeSubagent["status"] = "running"): RuntimeSubagent {
  return { id, title: id, status } as RuntimeSubagent;
}

function shell(id: string, createdAt: string, extra: { archivedAt?: string | null } = {}) {
  return { id, title: `title ${id}`, createdAt, archivedAt: extra.archivedAt ?? null };
}

describe("router job tags", () => {
  it("reads the tag Model Router opens every job thread with", () => {
    expect(
      parseRouterJobTag(
        `[model-router job router-80-release-t3 worker seq 2 on route muse-spark-xhigh-free; planner thread ${PLANNER}]\n\nThis turn belongs to ...`,
      ),
    ).toEqual({
      requestId: "router-80-release-t3",
      kind: "worker seq 2",
      route: "muse-spark-xhigh-free",
      plannerThreadId: PLANNER,
    });
  });

  it("ignores user prompts that merely mention a job", () => {
    expect(
      parseRouterJobTag("Implement Issue #17. [model-router job x y on route z; planner thread p]"),
    ).toBeNull();
    expect(
      routerJobTagOfMessages([
        {
          role: "assistant",
          text: `[model-router job a dispatcher on route luna/max; planner thread ${PLANNER}]`,
        },
        { role: "user", text: "Spawned by spawn_thread" },
      ]),
    ).toBeNull();
  });
});

describe("section assignment", () => {
  const dispatcherTag: RouterJobTag = {
    requestId: "job-1",
    kind: "dispatcher",
    route: "luna/max",
    plannerThreadId: PLANNER,
  };
  const workerTag: RouterJobTag = { ...dispatcherTag, kind: "worker seq 1", route: "muse-free" };

  it("keeps own spawns direct and groups router threads by job with the dispatcher route", () => {
    const sections = assignAgentSections(
      [
        agent("native-subagent"),
        agent(`sub.${PLANNER}.w1`, "idle"),
        agent(`sub.${PLANNER}.own`),
        agent(`sub.${PLANNER}.d1`, "failed"),
        agent(`sub.${PLANNER}.other`, "completed"),
      ],
      new Map([
        [`sub.${PLANNER}.w1`, workerTag],
        [`sub.${PLANNER}.own`, null],
        [`sub.${PLANNER}.d1`, dispatcherTag],
        [`sub.${PLANNER}.other`, { ...dispatcherTag, requestId: "job-2" }],
      ]),
    );
    expect(sections.directAgents.map((a) => a.id)).toEqual([
      "native-subagent",
      `sub.${PLANNER}.own`,
    ]);
    expect(sections.prismJobs.map((job) => [job.requestId, job.route, job.status])).toEqual([
      ["job-1", "luna/max", "failed"],
      ["job-2", "luna/max", "completed"],
    ]);
    expect(sections.prismJobs[0]!.agents.map((a) => a.id)).toEqual([
      `sub.${PLANNER}.w1`,
      `sub.${PLANNER}.d1`,
    ]);
  });

  it("leaves not-yet-read threads in Direct spawns", () => {
    const sections = assignAgentSections([agent(`sub.${PLANNER}.w1`)], new Map());
    expect(sections.directAgents).toHaveLength(1);
    expect(sections.prismJobs).toEqual([]);
  });
});

describe("child thread tree", () => {
  it("nests live children under their parent in spawn order", () => {
    const children = childThreadsByParent([
      shell(PLANNER, "2026-09-25T10:00:00Z"),
      shell(`sub.${PLANNER}.b`, "2026-09-25T10:02:00Z"),
      shell(`sub.${PLANNER}.a`, "2026-09-25T10:01:00Z"),
      shell(`sub.${PLANNER}.gone`, "2026-09-25T10:03:00Z", { archivedAt: "2026-09-25T11:00:00Z" }),
      shell(`sub.sub.${PLANNER}.a.x`, "2026-09-25T10:04:00Z"),
    ]);
    expect(children.get(PLANNER)?.map((s) => s.id)).toEqual([
      `sub.${PLANNER}.a`,
      `sub.${PLANNER}.b`,
    ]);
    expect(children.get(`sub.${PLANNER}.a`)?.map((s) => s.id)).toEqual([`sub.sub.${PLANNER}.a.x`]);
  });

  it("starts collapsed and toggles only the clicked row", () => {
    let expanded: ReadonlySet<string> = new Set();
    expanded = toggleExpandedThread(expanded, "a");
    expanded = toggleExpandedThread(expanded, "b");
    expect([...expanded]).toEqual(["a", "b"]);
    expanded = toggleExpandedThread(expanded, "a");
    expect([...expanded]).toEqual(["b"]);
  });

  it("reads a shell's status like the Agents panel does", () => {
    expect(threadShellStatus({ session: null, latestTurn: null })).toBe("pending");
    expect(threadShellStatus({ session: null, latestTurn: { state: "completed" } } as never)).toBe(
      "idle",
    );
    expect(threadShellStatus({ session: { status: "running" }, latestTurn: null } as never)).toBe(
      "running",
    );
    expect(threadShellStatus({ session: null, latestTurn: { state: "error" } } as never)).toBe(
      "failed",
    );
  });
});

describe("breadcrumb links", () => {
  const shells = [
    shell(PLANNER, "2026-09-25T10:00:00Z"),
    shell(`sub.${PLANNER}.a`, "2026-09-25T10:01:00Z"),
    shell(`sub.${PLANNER}.b`, "2026-09-25T10:02:00Z"),
  ];

  it("links a child thread to its parent and siblings", () => {
    const links = threadBreadcrumbLinks(`sub.${PLANNER}.b`, shells);
    expect(links?.parent.id).toBe(PLANNER);
    expect(links?.siblings.map((s) => s.id)).toEqual([`sub.${PLANNER}.a`, `sub.${PLANNER}.b`]);
  });

  it("prefers a real parentThreadId over the id convention", () => {
    const links = threadBreadcrumbLinks("child", [
      ...shells,
      { ...shell("child", "2026-09-25T10:05:00Z"), parentThreadId: PLANNER },
    ]);
    expect(links?.parent.id).toBe(PLANNER);
  });

  it("shows no crumbs for user threads or children whose parent is gone", () => {
    expect(threadBreadcrumbLinks(PLANNER, shells)).toBeNull();
    expect(
      threadBreadcrumbLinks("sub.missing.a", [shell("sub.missing.a", "2026-09-25T10:00:00Z")]),
    ).toBeNull();
  });
});
