import type { IssueDetail, IssueEvent } from "@t3tools/contracts";
import { stripLinearFileSignatures } from "@t3tools/issue-tracker-linear/shared/fileUrls";
import { LINEAR_KIND } from "@t3tools/issue-tracker-linear/shared/issueUrl";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export function issueDescriptionResetKey({ tracker, body }: Pick<IssueDetail, "tracker" | "body">) {
  return tracker === LINEAR_KIND ? stripLinearFileSignatures(body) : body;
}

/** "completed" → "Completed"; a reason the tracker spells with a dash reads as words. */
function issueCloseReasonLabel(reason: string): string {
  const words = reason.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function issueEventSentence(event: IssueEvent, resolve: MFunctionType = mFallback): string {
  switch (event.kind) {
    case "closed":
      return event.detail
        ? resolve(
            msg("closed this as {reason}", {
              reason: issueCloseReasonLabel(event.detail).toLowerCase(),
            }),
          )
        : resolve(msg("closed this"));
    case "reopened":
      return resolve(msg("reopened this"));
    case "labeled":
      return event.detail
        ? resolve(msg("added the {label} label", { label: event.detail }))
        : resolve(msg("added a label"));
    case "unlabeled":
      return event.detail
        ? resolve(msg("removed the {label} label", { label: event.detail }))
        : resolve(msg("removed a label"));
    case "assigned":
      return event.detail
        ? resolve(msg("assigned {person}", { person: event.detail }))
        : resolve(msg("assigned someone"));
    case "unassigned":
      return event.detail
        ? resolve(msg("unassigned {person}", { person: event.detail }))
        : resolve(msg("unassigned someone"));
    case "renamed":
      return event.detail
        ? resolve(msg("renamed this to “{title}”", { title: event.detail }))
        : resolve(msg("renamed this"));
    case "referenced":
      return event.detail
        ? resolve(msg("referenced this from {source}", { source: event.detail }))
        : resolve(msg("referenced this"));
    case "state-changed":
      return event.detail
        ? resolve(msg("moved this to {state}", { state: event.detail }))
        : resolve(msg("changed the state"));
  }
}

/**
 * What the viewer may do to an issue here: the client's write scope, the issue being inside a
 * project's scope, what the tracker can do at all, and what it grants this account.
 */
export function issueWriteAccess(
  detail: IssueDetail,
  canWrite: boolean,
  resolve: MFunctionType = mFallback,
) {
  const blocked = !canWrite
    ? resolve(msg("Writing to this tracker needs the source-control write scope."))
    : !detail.writable
      ? resolve(msg("This issue is outside every project's own scope, so it is read-only here."))
      : null;
  const may = (capability: boolean, permission: boolean) =>
    blocked === null && capability && permission;
  return {
    blocked,
    comment: may(detail.capabilities.comment, detail.viewerPermissions.comment),
    edit: may(detail.capabilities.edit, detail.viewerPermissions.edit),
    labels: may(detail.capabilities.labels, detail.viewerPermissions.labels),
    assignees: may(detail.capabilities.assignees, detail.viewerPermissions.assignees),
    react: blocked === null && detail.capabilities.reactions,
    /** The states the issue can move to; empty when the viewer may not move it. */
    states: may(true, detail.viewerPermissions.setState)
      ? detail.states.filter((state) => state.name !== detail.state.name)
      : [],
  };
}
