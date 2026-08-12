import { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildTrayAgentsModel, trayProjectRowLabel, trayThreadRowLabel } from "./trayMenu.ts";

const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

const ENVIRONMENT_ID = EnvironmentId.make("primary");

const project = (id: string, title: string) => ({
  id,
  title,
  workspaceRoot: `/home/user/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T10:00:00.000Z",
  updatedAt: "2026-08-12T10:00:00.000Z",
});

const thread = (input: {
  id: string;
  projectId: string;
  title: string;
  sessionStatus?: string;
  hasPendingApprovals?: boolean;
  archivedAt?: string;
}) => ({
  id: input.id,
  projectId: input.projectId,
  title: input.title,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "auto",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-12T10:00:00.000Z",
  updatedAt: "2026-08-12T10:05:00.000Z",
  archivedAt: input.archivedAt ?? null,
  session:
    input.sessionStatus === undefined
      ? null
      : {
          threadId: input.id,
          status: input.sessionStatus,
          providerName: "Codex",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-12T10:05:00.000Z",
        },
  latestUserMessageAt: null,
  hasPendingApprovals: input.hasPendingApprovals ?? false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const snapshot = (
  projects: ReadonlyArray<ReturnType<typeof project>>,
  threads: ReadonlyArray<ReturnType<typeof thread>>,
) =>
  decodeSnapshot({
    snapshotSequence: 1,
    projects,
    threads,
    updatedAt: "2026-08-12T10:05:00.000Z",
  });

describe("buildTrayAgentsModel", () => {
  it("reports unavailable when no snapshot could be loaded", () => {
    expect(buildTrayAgentsModel(ENVIRONMENT_ID, null)).toEqual({ kind: "unavailable" });
  });

  it("reports empty when no thread has a live agent", () => {
    const model = buildTrayAgentsModel(
      ENVIRONMENT_ID,
      snapshot(
        [project("p1", "Alpha")],
        [
          thread({ id: "t1", projectId: "p1", title: "Done work", sessionStatus: "ready" }),
          thread({ id: "t2", projectId: "p1", title: "No session" }),
        ],
      ),
    );
    expect(model).toEqual({ kind: "empty" });
  });

  it("groups running agents by project and sorts projects by title", () => {
    const model = buildTrayAgentsModel(
      ENVIRONMENT_ID,
      snapshot(
        [project("p1", "Zulu"), project("p2", "Alpha")],
        [
          thread({ id: "t1", projectId: "p1", title: "Fix bug", sessionStatus: "running" }),
          thread({ id: "t2", projectId: "p1", title: "Add docs", sessionStatus: "starting" }),
          thread({
            id: "t3",
            projectId: "p2",
            title: "Refactor",
            sessionStatus: "running",
            hasPendingApprovals: true,
          }),
        ],
      ),
    );

    expect(model.kind).toBe("projects");
    if (model.kind !== "projects") return;
    expect(model.projects.map((row) => row.title)).toEqual(["Alpha", "Zulu"]);
    expect(model.projects.map((row) => row.activeCount)).toEqual([1, 2]);
    // Approval-gated threads still count as live agents and surface why.
    expect(model.projects[0]?.threads[0]?.headline).toBe("Approval needed");
  });

  it("ignores archived threads and threads of unknown projects", () => {
    const model = buildTrayAgentsModel(
      ENVIRONMENT_ID,
      snapshot(
        [project("p1", "Alpha")],
        [
          thread({
            id: "t1",
            projectId: "p1",
            title: "Old",
            sessionStatus: "running",
            archivedAt: "2026-08-12T09:00:00.000Z",
          }),
          thread({ id: "t2", projectId: "ghost", title: "Orphan", sessionStatus: "running" }),
        ],
      ),
    );
    expect(model).toEqual({ kind: "empty" });
  });

  it("renders singular and plural row labels", () => {
    expect(
      trayProjectRowLabel({ title: "Alpha", activeCount: 1, threads: [] }),
    ).toBe("Alpha — 1 agent");
    expect(
      trayProjectRowLabel({ title: "Alpha", activeCount: 2, threads: [] }),
    ).toBe("Alpha — 2 agents");
    expect(trayThreadRowLabel({ title: "Fix bug", headline: "Agent is working" })).toBe(
      "Fix bug — Agent is working",
    );
  });
});
