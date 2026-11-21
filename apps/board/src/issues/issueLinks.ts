import {
  type IssueCommentInput,
  type IssueCreateInput,
  type IssueRef,
  type IssueSetStateInput,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";

import type { TrackerWrite } from "../domain/forYou";
import type { Ticket, TicketIssue } from "../domain/ticket";

export const LINEAR = "linear";
export const GITHUB = "github";
const LINEAR_HOST = "linear.app";

const LINEAR_KEY = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/;
const GITHUB_KEY = /^([^#\s/]+\/[^#\s/]+)?#([1-9][0-9]*)$/;
const KEYS_IN_TEXT =
  /\b(?:([A-Z][A-Z0-9_]*-[1-9][0-9]*)|([A-Za-z0-9][\w.-]*\/[\w.-]+#[1-9][0-9]*))(?![\w-])/g;

/** Every issue key in `text`, once each, in the order they first appear. */
export function findIssueKeys(text: string): ReadonlyArray<TicketIssue> {
  const found = new Map<string, TicketIssue>();
  for (const [, linear, github] of text.matchAll(KEYS_IN_TEXT)) {
    const issue =
      linear === undefined
        ? github === undefined
          ? null
          : { tracker: GITHUB, key: github }
        : { tracker: LINEAR, key: linear };
    if (issue !== null) found.set(`${issue.tracker} ${issue.key}`, issue);
  }
  return [...found.values()];
}

/** What a ticket needs to find its issue: the board's project and the repository its `#12` keys mean. */
export interface TicketIssueContext {
  readonly projectId: string;
  /** `owner/repo` of the project's GitHub remote, or null when it has none. */
  readonly githubScope: string | null;
}

/**
 * The address `issues.detail` reads an issue at, or null for a key this board cannot place. The
 * orchestrator writes the field by hand, so a key buried in a link or a sentence still resolves.
 */
export function issueRefOf(issue: TicketIssue, context: TicketIssueContext): IssueRef | null {
  const projectId = ProjectId.make(context.projectId);
  const key =
    findIssueKeys(issue.key).find((found) => found.tracker === issue.tracker)?.key ??
    issue.key.trim();
  if (issue.tracker === LINEAR) {
    const team = LINEAR_KEY.exec(key)?.[1];
    return team === undefined
      ? null
      : { projectId, tracker: IssueTrackerKind.make(LINEAR), host: LINEAR_HOST, scope: team, key };
  }
  if (issue.tracker === GITHUB) {
    const match = GITHUB_KEY.exec(key);
    const scope = match?.[1] ?? context.githubScope;
    const number = match?.[2];
    return scope == null || number === undefined
      ? null
      : { projectId, tracker: IssueTrackerKind.make(GITHUB), scope, key: number };
  }
  return null;
}

export function ticketIssueRef(
  ticket: Pick<Ticket, "issue">,
  context: TicketIssueContext,
): IssueRef | null {
  return ticket.issue == null ? null : issueRefOf(ticket.issue, context);
}

export function describeTrackerWrite(write: TrackerWrite): string {
  const where = `${write.scope} on ${write.tracker}`;
  switch (write.action) {
    case "create":
      return `Create an issue in ${where} titled "${write.title}"${write.body == null || write.body === "" ? "" : ` with this description:\n${write.body}`}`;
    case "set_state":
      return `Move ${write.key} in ${where} to "${write.state}"`;
    case "comment":
      return `Comment on ${write.key} in ${where}:\n${write.body}`;
  }
}

export type TrackerCall =
  | { readonly operation: "create"; readonly input: IssueCreateInput }
  | { readonly operation: "setState"; readonly input: IssueSetStateInput }
  | { readonly operation: "comment"; readonly input: IssueCommentInput };

export function trackerCall(write: TrackerWrite, projectId: string): TrackerCall {
  const scope = {
    projectId: ProjectId.make(projectId),
    tracker: IssueTrackerKind.make(write.tracker),
    ...(write.host == null ? {} : { host: write.host }),
    scope: write.scope,
  };
  switch (write.action) {
    case "create":
      return {
        operation: "create",
        input: {
          ...scope,
          title: write.title,
          body: write.body ?? "",
          labels: write.labels ?? [],
          assignees: write.assignees ?? [],
        },
      };
    case "set_state":
      return {
        operation: "setState",
        input: { ...scope, key: write.key.replace(/^#/, ""), state: write.state },
      };
    case "comment":
      return {
        operation: "comment",
        input: { ...scope, key: write.key.replace(/^#/, ""), body: write.body },
      };
  }
}

export interface IssueBrief {
  readonly tracker: string;
  readonly displayKey: string;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly author: string | null;
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly author: string | null;
    readonly createdAt: string;
    readonly body: string;
  }>;
}

// shortcut: one cut at the end, so a very long thread loses its newest comments; upgrade to summarising if it bites.
const BRIEF_LIMIT = 40_000;

export function issueBriefText(issue: IssueBrief): string {
  const comments = issue.comments.map(
    (comment) =>
      `**${comment.author ?? "someone"}** on ${comment.createdAt}:\n${comment.body.trim()}`,
  );
  const text = [
    `## ${issue.displayKey}: ${issue.title}`,
    `Tracker: ${issue.tracker}. State: ${issue.state}. Author: ${issue.author ?? "unknown"}. Link: ${issue.url}`,
    `### Description\n${issue.body.trim() === "" ? "No description." : issue.body.trim()}`,
    `### Comments (${comments.length})\n${comments.length === 0 ? "No comments." : comments.join("\n\n")}`,
  ].join("\n\n");
  return text.length <= BRIEF_LIMIT
    ? text
    : `${text.slice(0, BRIEF_LIMIT)}\n\n[The issue is longer than this message holds. Read the rest at ${issue.url}.]`;
}

export const ticketRequestMessage = (issue: IssueBrief): string =>
  `New ticket request: add a ticket for this issue, with its issue field set to {"tracker":"${issue.tracker}","key":"${issue.displayKey}"}.\n\n${issueBriefText(issue)}`;
