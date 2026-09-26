import {
  type EnvironmentId,
  type IssueKey,
  type IssueLinkChange,
  type IssueTarget,
  type ThreadIssueLinkSource,
  gitHubRepositoryOf,
  issueKeyString,
  parseIssueUrl,
} from "@t3tools/contracts";

export const ISSUE_LINK_SOURCE_LABELS: Record<ThreadIssueLinkSource, string> = {
  manual: "Linked by you",
  agent: "Linked by the agent",
  started: "Thread started from this Issue",
  branch: "Named by the thread's branch",
  "closing-reference": "Closed by a linked pull request",
};

/**
 * What the user typed into the link field: an Issue URL, `owner/repo#12`, `#12` or `12`. Bare
 * numbers leave the repository to the server, which uses the thread's project.
 */
export function parseIssueReferenceInput(text: string): IssueTarget | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/^https?:\/\//iu.test(trimmed)) {
    return parseIssueUrl(trimmed) === null ? null : { url: trimmed };
  }
  const match = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/u.exec(trimmed);
  if (match === null) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return match[1] === undefined ? { number } : { repository: match[1], number };
}

/** An Issue as "Start thread" needs it. Title and body are null where only the link is known. */
export interface StartableIssue extends IssueKey {
  readonly url: string;
  readonly title: string | null;
  readonly body: string | null;
}

/** The composer text a thread started from an Issue opens with; the user sends it. */
export function issueStartPrompt(issue: StartableIssue): string {
  const title = issue.title?.trim() ?? "";
  const body = issue.body?.trim() ?? "";
  return [title, issue.url, body].filter((part) => part.length > 0).join("\n\n");
}

interface ProjectCandidate {
  readonly repositoryIdentity?:
    | { readonly canonicalKey: string; readonly provider?: string | undefined }
    | null
    | undefined;
}

/**
 * The first project checked out from the Issue's repository, or why none can start a thread.
 * Projects `preferred` accepts win, e.g. ones on servers that keep Issue links, so the new
 * thread can be linked at once.
 */
export function resolveIssueProject<P extends ProjectCandidate>(
  projects: ReadonlyArray<P>,
  issue: IssueKey,
  preferred?: (project: P) => boolean,
): { readonly project: P } | { readonly reason: string } {
  const checkouts = projects.filter((candidate) => {
    const repository = gitHubRepositoryOf(candidate.repositoryIdentity);
    return (
      repository !== null &&
      repository.host === issue.host.toLowerCase() &&
      repository.repository === issue.repository.toLowerCase()
    );
  });
  const project = (preferred === undefined ? undefined : checkouts.find(preferred)) ?? checkouts[0];
  return project === undefined
    ? { reason: `No project is a checkout of ${issue.repository}. Add one to start a thread.` }
    : { project };
}

/**
 * The server an Issue side panel reads through: the one the link names when it lists Issues,
 * else a server that lists Issues and checks the repository out, one keeping Issue links first.
 * Null when none does, so a shared link never reaches a server without `issues.*`.
 */
export function resolveIssuePanelEnvironment<
  P extends ProjectCandidate & { readonly environmentId: EnvironmentId },
>(
  issue: IssueKey,
  named: EnvironmentId | undefined,
  projects: ReadonlyArray<P>,
  servers: {
    readonly issues: ReadonlyArray<EnvironmentId>;
    readonly issueLinks: ReadonlyArray<EnvironmentId>;
  },
): EnvironmentId | null {
  if (named !== undefined && servers.issues.includes(named)) return named;
  const owner = resolveIssueProject(
    projects.filter((project) => servers.issues.includes(project.environmentId)),
    issue,
    (project) => servers.issueLinks.includes(project.environmentId),
  );
  return "project" in owner ? owner.project.environmentId : null;
}

/**
 * Opens a draft in the Issue's project, writes the Issue into its composer and links the draft's
 * thread id at once, so the thread is linked from its first send. Null when nothing opened.
 */
export async function startThreadFromIssue<
  P extends ProjectCandidate,
  O extends { readonly draftId: unknown; readonly threadId: unknown },
>(
  issue: StartableIssue,
  steps: {
    readonly projects: ReadonlyArray<P>;
    readonly preferred?: (project: P) => boolean;
    readonly openDraft: (project: P) => Promise<O | null>;
    readonly writePrompt: (draftId: O["draftId"], prompt: string) => void;
    readonly link: (project: P, threadId: O["threadId"], url: string) => Promise<unknown>;
  },
): Promise<O | null> {
  const target = resolveIssueProject(steps.projects, issue, steps.preferred);
  if (!("project" in target)) return null;
  const opened = await steps.openDraft(target.project);
  if (opened === null) return null;
  steps.writePrompt(opened.draftId, issueStartPrompt(issue));
  await steps.link(target.project, opened.threadId, issue.url);
  return opened;
}

/** Whether any change in a delivered batch names the thread or one of the Issue keys. */
export function issueLinkChangesMatch(
  batch: ReadonlyArray<IssueLinkChange>,
  target: { readonly threadId: string | null; readonly issues: ReadonlyArray<string> },
): boolean {
  const wanted = new Set(target.issues);
  return batch.some(
    (change) =>
      change.threadId === target.threadId ||
      change.issues.some((issue) => wanted.has(issueKeyString(issue))),
  );
}
