/**
 * The planning scene builder: maps backlog `ProjectTicket`s into the scene
 * domain model (§10). Subtasks are the planning unit; stories aggregate them;
 * subtask parents outside the sprint become context-parent placeholders. Split
 * out of t3work-planningSpaceData.ts.
 */

import type { ProjectTicket } from "~/t3work/t3work-types";

import {
  DEFAULT_RESOLVED_STATUSES,
  NO_EPIC_ID,
  type BuildPlanningSceneOptions,
  type PlanningEpic,
  type PlanningSceneData,
  type PlanningStory,
  type PlanningSubtask,
} from "./t3work-planningSpaceData";
import {
  computePlanningOwners,
  isResolved,
  ownerOf,
  placeholderTitle,
  planningStateOf,
} from "./t3work-planningSpaceSceneBuildHelpers";
import { orderEpicsByAffinity } from "./t3work-planningSpaceScene";

export function buildPlanningSceneData(
  tickets: ReadonlyArray<ProjectTicket>,
  options: BuildPlanningSceneOptions = {},
): PlanningSceneData {
  const resolvedStatuses = options.resolvedStatuses ?? DEFAULT_RESOLVED_STATUSES;
  const inSprint = (ticket: ProjectTicket): boolean =>
    options.sprintId ? ticket.sprintId === options.sprintId : ticket.sprintState === "active";

  const byId = new Map(tickets.map((t) => [t.id, t]));
  const epicTickets = tickets.filter(
    (t) => !t.issueTypeIsSubtask && t.issueType?.toLowerCase() === "epic",
  );
  const epicIds = new Set(epicTickets.map((t) => t.id));
  const subtaskTickets = tickets.filter((t) => t.issueTypeIsSubtask === true);
  const storyTickets = tickets.filter((t) => !t.issueTypeIsSubtask && !epicIds.has(t.id));

  const subtasksByParent = new Map<string, PlanningSubtask[]>();
  const unparentedSubtaskIds: string[] = [];
  for (const ticket of subtaskTickets) {
    if (!ticket.parentId) {
      unparentedSubtaskIds.push(ticket.id);
      continue;
    }
    const owner = ownerOf(ticket);
    const resolved = isResolved(ticket, resolvedStatuses);
    const subtask: PlanningSubtask = {
      id: ticket.id,
      key: ticket.ref.displayId,
      title: ticket.ref.title,
      parentId: ticket.parentId,
      ownerId: owner.ownerId,
      ownerName: owner.ownerName,
      hoursSeconds: ticket.timeOriginalEstimateSeconds ?? 0,
      remainingSeconds: resolved
        ? 0
        : (ticket.timeRemainingEstimateSeconds ?? ticket.timeOriginalEstimateSeconds ?? 0),
      inSprint: inSprint(ticket),
      resolved,
      description: ticket.description ?? null,
    };
    subtasksByParent.set(ticket.parentId, [
      ...(subtasksByParent.get(ticket.parentId) ?? []),
      subtask,
    ]);
  }

  const stories: PlanningStory[] = [];
  const storyIds = new Set<string>();

  const pushStory = (
    ticket: ProjectTicket | null,
    id: string,
    subtasks: ReadonlyArray<PlanningSubtask>,
  ) => {
    const sprintMember = ticket ? inSprint(ticket) : false;
    const aggregate = subtasks.reduce((sum, s) => sum + s.hoursSeconds, 0);
    const ownHours = ticket?.timeOriginalEstimateSeconds ?? 0;
    const owner = ticket ? ownerOf(ticket) : { ownerId: null, ownerName: null };
    const estimated = ownHours > 0 || aggregate > 0 || (ticket?.estimateValue ?? 0) > 0;
    const parentTicket = ticket?.parentId ? (byId.get(ticket.parentId) ?? null) : null;
    const epicId = ticket?.parentId
      ? epicIds.has(ticket.parentId) || parentTicket === null
        ? ticket.parentId
        : NO_EPIC_ID
      : NO_EPIC_ID;
    stories.push({
      id,
      key: ticket?.ref.displayId ?? id,
      title: ticket?.ref.title ?? placeholderTitle(id, "story"),
      epicId,
      issueType: ticket?.issueType ?? "Story",
      issueTypeIconUrl: ticket?.issueTypeIconUrl ?? ticket?.ref.issueTypeIconUrl ?? null,
      ownerId: owner.ownerId,
      ownerName: owner.ownerName,
      inSprint: sprintMember,
      isContextParent: !sprintMember && subtasks.some((s) => s.inSprint),
      isPlaceholder: ticket === null,
      resolved: ticket ? isResolved(ticket, resolvedStatuses) : false,
      ownHoursSeconds: ownHours,
      ownRemainingSeconds: ticket?.timeRemainingEstimateSeconds ?? ownHours,
      subtasks,
      aggregateHoursSeconds: aggregate,
      planningState: planningStateOf(owner.ownerId, estimated),
      description: ticket?.description ?? null,
    });
    storyIds.add(id);
  };

  for (const ticket of storyTickets) {
    pushStory(ticket, ticket.id, subtasksByParent.get(ticket.id) ?? []);
  }
  for (const [parentId, subtasks] of subtasksByParent) {
    if (storyIds.has(parentId) || epicIds.has(parentId)) continue;
    pushStory(byId.get(parentId) ?? null, parentId, subtasks);
  }

  const epics: PlanningEpic[] = [];
  const epicIdsInUse = [...new Set(stories.map((s) => s.epicId))];
  for (const epicId of epicIdsInUse) {
    const epicTicket = byId.get(epicId) ?? null;
    const members = stories.filter((s) => s.epicId === epicId);
    epics.push({
      id: epicId,
      key: epicTicket?.ref.displayId ?? (epicId === NO_EPIC_ID ? "" : epicId),
      title:
        epicTicket?.ref.title ??
        (epicId === NO_EPIC_ID ? "No epic" : placeholderTitle(epicId, "epic")),
      storyIds: members.map((s) => s.id),
      totalHoursSeconds: members.reduce(
        (sum, s) => sum + Math.max(s.aggregateHoursSeconds, s.ownHoursSeconds),
        0,
      ),
      readyCount: members.filter((s) => s.planningState === "ready").length,
    });
  }

  const storyCountByEpic = new Map(epics.map((e) => [e.id, e.storyIds.length]));
  const orderedWithCatchAll = orderEpicsByAffinity(
    epics.map((e) => e.id),
    storyCountByEpic,
    options.epicAffinity ?? new Map(),
  );
  const epicOrder = [
    ...orderedWithCatchAll.filter((id) => id !== NO_EPIC_ID),
    ...orderedWithCatchAll.filter((id) => id === NO_EPIC_ID),
  ];

  const owners = computePlanningOwners(tickets, stories, options.currentUser);

  return { stories, epics, epicOrder, owners, unparentedSubtaskIds };
}
