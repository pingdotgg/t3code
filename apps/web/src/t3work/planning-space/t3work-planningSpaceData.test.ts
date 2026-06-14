import { describe, expect, it } from "vite-plus/test";

import type { ProjectTicket } from "~/t3work/t3work-types";

import {
  NO_EPIC_ID,
  buildPlanningSceneData,
  sortPlanningOwners,
} from "./t3work-planningSpaceData";

const SPRINT = "3185";

function ticket(partial: {
  id: string;
  title?: string;
  issueType?: string;
  subtask?: boolean;
  parentId?: string;
  assignee?: string;
  accountId?: string;
  hours?: number;
  points?: number;
  status?: string;
  inSprint?: boolean;
}): ProjectTicket {
  return {
    id: partial.id,
    projectId: "p1",
    ref: {
      provider: "atlassian",
      kind: "jira-issue",
      id: partial.id,
      displayId: partial.id,
      title: partial.title ?? `Title ${partial.id}`,
      url: `https://example.atlassian.net/browse/${partial.id}`,
      projectId: "p1",
    },
    issueType: partial.issueType ?? (partial.subtask ? "Task" : "Story"),
    issueTypeIsSubtask: partial.subtask ?? false,
    status: partial.status ?? "In Progress",
    updatedAt: "2026-06-10T00:00:00Z",
    ...(partial.parentId !== undefined ? { parentId: partial.parentId } : {}),
    ...(partial.assignee !== undefined ? { assignee: partial.assignee } : {}),
    ...(partial.accountId !== undefined ? { assigneeAccountId: partial.accountId } : {}),
    ...(partial.points !== undefined ? { estimateValue: partial.points } : {}),
    ...(partial.hours !== undefined ? { timeOriginalEstimateSeconds: partial.hours } : {}),
    ...(partial.inSprint ? { sprintId: SPRINT, sprintState: "active" as const } : {}),
  };
}

/** Mirrors a real subtask-shaped sprint: subtask-shaped sprint, orphan parents, German done states. */
function realisticFixture(): ProjectTicket[] {
  return [
    ticket({ id: "EPIC-1", issueType: "Epic", title: "Dateiablage" }),
    ticket({
      id: "ST-1",
      parentId: "EPIC-1",
      title: "Stammdaten importieren",
      assignee: "Mara Castellan",
      accountId: "acc-mc",
      inSprint: true,
    }),
    ticket({
      id: "SUB-1a",
      subtask: true,
      parentId: "ST-1",
      title: "Backend",
      assignee: "Selina Egger",
      accountId: "acc-se",
      hours: 36000,
      inSprint: true,
    }),
    ticket({
      id: "SUB-1b",
      subtask: true,
      parentId: "ST-1",
      title: "Frontend",
      assignee: "Timo Degen",
      accountId: "acc-td",
      hours: 57600,
      status: "Erledigt",
      inSprint: true,
    }),
    ticket({
      id: "SUB-orphan",
      subtask: true,
      parentId: "ST-NOT-LOADED",
      title: "GIS-Routing Integration",
      assignee: "Basil Wirthlin",
      accountId: "acc-bw",
      hours: 72000,
      inSprint: true,
    }),
    ticket({
      id: "ST-2",
      parentId: "EPIC-UNLOADED",
      title: "Bug ohne alles",
      issueType: "Bug",
      inSprint: true,
    }),
    ticket({
      id: "ST-3",
      title: "Backlog story with own estimate",
      assignee: "Cyrill Hauri",
      accountId: "acc-ch",
      hours: 28800,
      inSprint: false,
    }),
    ticket({
      id: "SUB-broken",
      subtask: true,
      title: "Subtask without parent id",
      inSprint: true,
    }),
  ];
}

describe("buildPlanningSceneData", () => {
  const data = buildPlanningSceneData(realisticFixture(), { sprintId: SPRINT });

  it("classifies the hierarchy and attaches subtasks to their stories", () => {
    const st1 = data.stories.find((s) => s.id === "ST-1");
    expect(st1).toBeDefined();
    expect(st1?.epicId).toBe("EPIC-1");
    expect(st1?.subtasks.map((s) => s.id).sort()).toEqual(["SUB-1a", "SUB-1b"]);
    expect(st1?.aggregateHoursSeconds).toBe(36000 + 57600);
  });

  it("synthesizes a context-parent placeholder for orphan subtask parents", () => {
    const placeholder = data.stories.find((s) => s.id === "ST-NOT-LOADED");
    expect(placeholder).toBeDefined();
    expect(placeholder?.isPlaceholder).toBe(true);
    expect(placeholder?.title).toBe("ST-NOT-LOADED");
    expect(placeholder?.isContextParent).toBe(true);
    expect(placeholder?.inSprint).toBe(false);
    expect(placeholder?.subtasks.map((s) => s.id)).toEqual(["SUB-orphan"]);
  });

  it("derives planning state from the subtask aggregate (real-data finding F3)", () => {
    const st1 = data.stories.find((s) => s.id === "ST-1");
    expect(st1?.ownHoursSeconds).toBe(0);
    expect(st1?.planningState).toBe("ready");
    const st2 = data.stories.find((s) => s.id === "ST-2");
    expect(st2?.planningState).toBe("needs-owner-and-estimate");
    const st3 = data.stories.find((s) => s.id === "ST-3");
    expect(st3?.planningState).toBe("ready");
  });

  it("treats unknown story parents as not-yet-loaded epics", () => {
    const st2 = data.stories.find((s) => s.id === "ST-2");
    expect(st2?.epicId).toBe("EPIC-UNLOADED");
    const epic = data.epics.find((e) => e.id === "EPIC-UNLOADED");
    expect(epic?.title).toBe("Epic EPIC-UNLOADED");
  });

  it("buckets placeholder parents under no-epic until their ticket loads", () => {
    const placeholder = data.stories.find((s) => s.id === "ST-NOT-LOADED");
    expect(placeholder?.epicId).toBe(NO_EPIC_ID);
  });

  it("lists every backlog assignee on the rail and loads hours from in-sprint subtasks only", () => {
    const byId = new Map(data.owners.map((o) => [o.id, o.loadSeconds]));
    expect(byId.get("acc-se")).toBe(36000);
    expect(byId.get("acc-td")).toBe(57600);
    expect(byId.get("acc-bw")).toBe(72000);
    expect(byId.get("acc-mc")).toBe(0);
    expect(byId.get("acc-ch")).toBe(0);
  });

  it("sorts the current user leftmost on the rail, then by load (§6.6)", () => {
    const ordered = buildPlanningSceneData(realisticFixture(), {
      sprintId: SPRINT,
      currentUser: { displayName: "Selina Egger" },
    }).owners.map((owner) => owner.id);
    expect(ordered[0]).toBe("acc-se");
    expect(ordered.indexOf("acc-se")).toBeLessThan(ordered.indexOf("acc-bw"));
  });

  it("honors the selected sprint id when sprintState is future (planning-day default)", () => {
    const futureSprint = realisticFixture().map((ticket) =>
      ticket.sprintId === SPRINT
        ? { ...ticket, sprintState: "future" as const }
        : ticket,
    );
    const planned = buildPlanningSceneData(futureSprint, { sprintId: SPRINT });
    const withoutSelection = buildPlanningSceneData(futureSprint);
    expect(planned.stories.find((s) => s.id === "ST-1")?.inSprint).toBe(true);
    expect(withoutSelection.stories.find((s) => s.id === "ST-1")?.inSprint).toBe(
      false,
    );
    expect(planned.owners.some((owner) => owner.id === "acc-se")).toBe(true);
  });

  it("marks German resolved statuses as resolved without a checkbox concept", () => {
    const st1 = data.stories.find((s) => s.id === "ST-1");
    const frontend = st1?.subtasks.find((s) => s.id === "SUB-1b");
    expect(frontend?.resolved).toBe(true);
    const backend = st1?.subtasks.find((s) => s.id === "SUB-1a");
    expect(backend?.resolved).toBe(false);
  });

  it("reports subtasks without any parent instead of dropping them silently", () => {
    expect(data.unparentedSubtaskIds).toEqual(["SUB-broken"]);
  });

  it("orders real epics first and the no-epic catch-all last, deterministically", () => {
    expect(data.epicOrder[data.epicOrder.length - 1]).toBe(NO_EPIC_ID);
    expect(data.epicOrder.slice(0, 2).sort()).toEqual(["EPIC-1", "EPIC-UNLOADED"]);
    const again = buildPlanningSceneData(realisticFixture(), {
      sprintId: SPRINT,
    });
    expect(again.epicOrder).toEqual(data.epicOrder);
  });

  it("sortPlanningOwners keeps account-id matches ahead of load", () => {
    const owners = sortPlanningOwners(
      [
        { id: "acc-heavy", name: "Heavy Load", loadSeconds: 99_000, remainingSeconds: 99_000 },
        { id: "acc-me", name: "Me", loadSeconds: 0, remainingSeconds: 0 },
      ],
      { accountId: "acc-me" },
    );
    expect(owners[0]?.id).toBe("acc-me");
  });

  it("counts epic hours from the larger of own and aggregate story effort", () => {
    const epic = data.epics.find((e) => e.id === "EPIC-1");
    expect(epic?.totalHoursSeconds).toBe(36000 + 57600);
    expect(epic?.readyCount).toBe(1);
  });
});
