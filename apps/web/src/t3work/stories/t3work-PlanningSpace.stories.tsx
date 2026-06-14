import type { Meta, StoryObj } from "@storybook/react";
import { useRef, useState } from "react";

import type { PlanningItemRef } from "~/t3work/planning-space/t3work-planningSpaceInteractions";
import { PlanningSpaceView } from "~/t3work/planning-space/t3work-PlanningSpaceView";
import {
  PLANNING_SPACE_FIXTURE_OWNER_ROLES,
  PLANNING_SPACE_FIXTURE_SPRINT_ID,
  planningSpaceFixtureTickets,
} from "~/t3work/planning-space/t3work-planningSpaceFixtures";
import type { ProjectTicket } from "~/t3work/t3work-types";

/**
 * Stateful host: applies planning-space mutations to the local ticket set the
 * way the real backlog applies optimistic write-through — so every gesture in
 * the story is fully functional.
 */
function PlanningSpaceFixtureView({ sprintId }: { sprintId?: string }) {
  const [tickets, setTickets] = useState<readonly ProjectTicket[]>(() =>
    planningSpaceFixtureTickets(),
  );

  const assigneeFieldsFor = (
    ownerId: string | null,
  ): Pick<ProjectTicket, "assignee" | "assigneeAccountId"> => {
    if (ownerId === null) return {};
    const source = tickets.find((t) => t.assigneeAccountId === ownerId);
    return {
      assignee: source?.assignee ?? ownerId.replace(/^acc-/, ""),
      assigneeAccountId: ownerId,
    };
  };

  const updateTicket = (
    ticketId: string,
    patch: (ticket: ProjectTicket) => ProjectTicket,
  ) => {
    setTickets((current) =>
      current.map((ticket) => (ticket.id === ticketId ? patch(ticket) : ticket)),
    );
  };

  const onAssign = (item: PlanningItemRef, ownerId: string | null) => {
    const targetId = item.kind === "story" ? item.storyId : item.subtaskId;
    updateTicket(targetId, (ticket) => {
      const next = { ...ticket };
      delete next.assignee;
      delete next.assigneeAccountId;
      return { ...next, ...assigneeFieldsFor(ownerId) };
    });
  };

  const onSetSprintMembership = (storyId: string, inSprint: boolean) => {
    updateTicket(storyId, (ticket) => {
      const next = { ...ticket };
      if (inSprint) {
        return {
          ...next,
          sprintId: PLANNING_SPACE_FIXTURE_SPRINT_ID,
          sprintName: "Dispo Sprint 6.4",
          sprintState: "active",
        };
      }
      delete next.sprintId;
      delete next.sprintName;
      delete next.sprintState;
      return next;
    });
  };

  const onReparent = (storyId: string, epicId: string) => {
    updateTicket(storyId, (ticket) => ({ ...ticket, parentId: epicId }));
  };

  const onSetSubtaskHours = (subtaskId: string, seconds: number) => {
    updateTicket(subtaskId, (ticket) => {
      const next = { ...ticket };
      if (seconds <= 0) {
        delete next.timeOriginalEstimateSeconds;
        return next;
      }
      return { ...next, timeOriginalEstimateSeconds: seconds };
    });
  };

  const createdCount = useRef(0);
  const onCreateSubtask = (storyId: string, title: string) => {
    createdCount.current += 1;
    const id = `FLT-NEW-${createdCount.current}`;
    setTickets((current) => [
      ...current,
      {
        id,
        projectId: "fixture-project",
        parentId: storyId,
        ref: {
          provider: "atlassian",
          kind: "jira-issue",
          id,
          displayId: id,
          title,
          url: `https://example.invalid/browse/${id}`,
          projectId: "fixture-project",
        },
        issueType: "Task",
        issueTypeIsSubtask: true,
        status: "To Do",
        updatedAt: "2026-06-10T08:00:00Z",
        sprintId: PLANNING_SPACE_FIXTURE_SPRINT_ID,
        sprintName: "Dispo Sprint 6.4",
        sprintState: "active",
      },
    ]);
  };

  return (
    <div style={{ height: "100vh", padding: 12, boxSizing: "border-box" }}>
      <PlanningSpaceView
        tickets={tickets}
        {...(sprintId !== undefined ? { sprintId } : {})}
        ownerRoles={PLANNING_SPACE_FIXTURE_OWNER_ROLES}
        mutations={{
          onAssign,
          onSetSprintMembership,
          onReparent,
          onSetSubtaskHours,
          onCreateSubtask,
        }}
      />
    </div>
  );
}

const meta = {
  title: "T3work/Project Dashboard/Planning Space",
  component: PlanningSpaceFixtureView,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof PlanningSpaceFixtureView>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The verified real-sprint shape: subtask-heavy, context parents, 18 people. */
export const RealisticSprint: Story = {
  args: { sprintId: PLANNING_SPACE_FIXTURE_SPRINT_ID },
};
