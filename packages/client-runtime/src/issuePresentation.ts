import type { IssueDetail, IssueEvent, IssueState } from "@t3tools/contracts";

/** "completed" → "Completed"; a reason the tracker spells with a dash reads as words. */
export function issueCloseReasonLabel(reason: string): string {
  const words = reason.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The tracker's own state name is the label, so a workflow tracker's "In Review" reads as itself. */
export function issueStateLabel(state: IssueState): string {
  if (state.category === "open") return state.name === "open" ? "Open" : state.name;
  if (state.closeReason === "not-planned") return "Closed as not planned";
  if (state.name !== "closed") return state.name;
  return state.closeReason === "completed" ? "Closed as completed" : "Closed";
}

export function issueEventSentence(event: IssueEvent): string {
  switch (event.kind) {
    case "closed":
      return event.detail
        ? `closed this as ${issueCloseReasonLabel(event.detail).toLowerCase()}`
        : "closed this";
    case "reopened":
      return "reopened this";
    case "labeled":
      return event.detail ? `added the ${event.detail} label` : "added a label";
    case "unlabeled":
      return event.detail ? `removed the ${event.detail} label` : "removed a label";
    case "assigned":
      return event.detail ? `assigned ${event.detail}` : "assigned someone";
    case "unassigned":
      return event.detail ? `unassigned ${event.detail}` : "unassigned someone";
    case "renamed":
      return event.detail ? `renamed this to “${event.detail}”` : "renamed this";
    case "referenced":
      return event.detail ? `referenced this from ${event.detail}` : "referenced this";
    case "state-changed":
      return event.detail ? `moved this to ${event.detail}` : "changed the state";
  }
}

/**
 * What the viewer may do to an issue here: the client's write scope, the issue being inside a
 * project's scope, what the tracker can do at all, and what it grants this account.
 */
export function issueWriteAccess(detail: IssueDetail, canWrite: boolean) {
  const blocked = !canWrite
    ? "Writing to this tracker needs the source-control write scope."
    : !detail.writable
      ? "This issue is outside every project's own scope, so it is read-only here."
      : null;
  const may = (capability: boolean, permission: boolean) =>
    blocked === null && capability && permission;
  const others = detail.capabilities.states.filter(
    (state) => state.category !== detail.state.category || state.name !== detail.state.name,
  );
  return {
    blocked,
    comment: may(detail.capabilities.comment, detail.viewerPermissions.comment),
    edit: may(detail.capabilities.edit, detail.viewerPermissions.edit),
    labels: may(detail.capabilities.labels, detail.viewerPermissions.labels),
    assignees: may(detail.capabilities.assignees, detail.viewerPermissions.assignees),
    react: blocked === null && detail.capabilities.reactions,
    /** The states the issue can move to; empty when the viewer may not move it. */
    states: may(detail.capabilities.states.length > 0, detail.viewerPermissions.setState)
      ? others
      : [],
  };
}
