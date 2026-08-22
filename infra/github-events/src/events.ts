type JsonObject = Readonly<Record<string, unknown>>;

export interface GitHubActor {
  readonly id: number | null;
  readonly login: string;
  readonly avatarUrl: string | null;
}

export interface GitHubRepository {
  readonly id: number | null;
  readonly fullName: string;
  readonly url: string | null;
}

export interface GitHubEvent {
  readonly version: 1;
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly repository: GitHubRepository;
  readonly pullRequestNumbers: ReadonlyArray<number>;
  readonly headSha: string | null;
  readonly actor: GitHubActor | null;
  readonly receivedAt: string | null;
  readonly occurredAt: string | null;
  readonly details: JsonObject;
}

export interface NormalizeWebhookInput {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly receivedAt?: string;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function actorFrom(value: unknown): GitHubActor | null {
  const actor = asObject(value);
  const login = stringValue(actor?.login);
  if (!actor || !login) return null;
  return {
    id: numberValue(actor.id),
    login,
    avatarUrl: stringValue(actor.avatar_url),
  };
}

function commentFrom(value: unknown): JsonObject | null {
  const comment = asObject(value);
  const id = numberValue(comment?.id);
  const body = stringValue(comment?.body);
  if (!comment || id === null || body === null) return null;
  return {
    id,
    body,
    author: actorFrom(comment.user),
    url: stringValue(comment.html_url),
    createdAt: stringValue(comment.created_at),
    updatedAt: stringValue(comment.updated_at),
    path: stringValue(comment.path),
    line: numberValue(comment.line),
    side: stringValue(comment.side),
    diffHunk: stringValue(comment.diff_hunk),
    commitId: stringValue(comment.commit_id),
    originalCommitId: stringValue(comment.original_commit_id),
    inReplyToId: numberValue(comment.in_reply_to_id),
  };
}

function repositoryRefFrom(value: unknown): JsonObject | null {
  const repository = asObject(value);
  if (!repository) return null;
  const id = numberValue(repository.id);
  const fullName = stringValue(repository.full_name);
  const name = stringValue(repository.name);
  if (id === null || (!fullName && !name)) return null;
  return {
    id,
    fullName,
    name,
    url: stringValue(repository.html_url),
  };
}

function refFrom(value: unknown): JsonObject | null {
  const ref = asObject(value);
  const name = stringValue(ref?.ref);
  const sha = stringValue(ref?.sha);
  return ref && name && sha ? { ref: name, sha, repository: repositoryRefFrom(ref.repo) } : null;
}

function pullRequestFrom(value: unknown, repositoryId: number): JsonObject | null {
  const pullRequest = asObject(value);
  const number = numberValue(pullRequest?.number);
  const title = stringValue(pullRequest?.title);
  const state = stringValue(pullRequest?.state);
  const baseRepositoryId = numberValue(asObject(asObject(pullRequest?.base)?.repo)?.id);
  if (!pullRequest || number === null || !title || !state || baseRepositoryId !== repositoryId) {
    return null;
  }
  return {
    number,
    title,
    state,
    draft: booleanValue(pullRequest.draft),
    merged: booleanValue(pullRequest.merged),
    mergeable: booleanValue(pullRequest.mergeable),
    mergeableState: stringValue(pullRequest.mergeable_state),
    author: actorFrom(pullRequest.user),
    url: stringValue(pullRequest.html_url),
    createdAt: stringValue(pullRequest.created_at),
    updatedAt: stringValue(pullRequest.updated_at),
    closedAt: stringValue(pullRequest.closed_at),
    mergedAt: stringValue(pullRequest.merged_at),
    head: refFrom(pullRequest.head),
    base: refFrom(pullRequest.base),
  };
}

function reviewFrom(value: unknown): JsonObject | null {
  const review = asObject(value);
  const id = numberValue(review?.id);
  const state = stringValue(review?.state);
  if (!review || id === null || !state) return null;
  return {
    id,
    body: stringValue(review.body),
    state,
    author: actorFrom(review.user),
    url: stringValue(review.html_url),
    commitId: stringValue(review.commit_id),
    submittedAt: stringValue(review.submitted_at),
  };
}

function pullRequestNumbersFrom(value: unknown, repositoryId: number): ReadonlyArray<number> {
  if (!Array.isArray(value)) return [];
  const numbers = value.flatMap((item) => {
    const pullRequest = asObject(item);
    const id = numberValue(pullRequest?.id);
    const number = numberValue(pullRequest?.number);
    const head = asObject(pullRequest?.head);
    const base = asObject(pullRequest?.base);
    const headRepository = asObject(head?.repo);
    const baseRepository = asObject(base?.repo);
    if (
      id === null ||
      number === null ||
      !stringValue(pullRequest?.url) ||
      !stringValue(head?.ref) ||
      !stringValue(head?.sha) ||
      numberValue(headRepository?.id) === null ||
      !stringValue(headRepository?.url) ||
      !stringValue(headRepository?.name) ||
      !stringValue(base?.ref) ||
      !stringValue(base?.sha) ||
      numberValue(baseRepository?.id) !== repositoryId ||
      !stringValue(baseRepository?.url) ||
      !stringValue(baseRepository?.name)
    ) {
      return [];
    }
    return [number];
  });
  return [...new Set(numbers)];
}

function checkRunFrom(value: unknown, repositoryId: number): JsonObject | null {
  const check = asObject(value);
  const id = numberValue(check?.id);
  const name = stringValue(check?.name);
  const status = stringValue(check?.status);
  const headSha = stringValue(check?.head_sha);
  if (!check || id === null || !name || !status || !headSha) return null;
  const output = asObject(check.output);
  return {
    id,
    name,
    status,
    conclusion: stringValue(check.conclusion),
    headSha,
    url: stringValue(check.html_url),
    detailsUrl: stringValue(check.details_url),
    startedAt: stringValue(check.started_at),
    completedAt: stringValue(check.completed_at),
    output: output
      ? {
          title: stringValue(output.title),
          summary: stringValue(output.summary),
          text: stringValue(output.text),
          annotationsCount: nonNegativeNumberValue(output.annotations_count),
        }
      : null,
    pullRequestNumbers: pullRequestNumbersFrom(check.pull_requests, repositoryId),
  };
}

function issueFrom(value: unknown): JsonObject | null {
  const issue = asObject(value);
  const number = numberValue(issue?.number);
  const title = stringValue(issue?.title);
  const state = stringValue(issue?.state);
  if (!issue || number === null || !title || !state) return null;
  const labels = Array.isArray(issue.labels)
    ? issue.labels.flatMap((value) => {
        const name = typeof value === "string" ? value : stringValue(asObject(value)?.name);
        return name ? [name] : [];
      })
    : [];
  return {
    number,
    title,
    state,
    locked: booleanValue(issue.locked),
    author: actorFrom(issue.user),
    url: stringValue(issue.html_url),
    labels,
  };
}

function pullRequestActionDetails(payload: JsonObject): JsonObject {
  const label = asObject(payload.label);
  const team = asObject(payload.requested_team);
  const milestone = asObject(payload.milestone);
  return {
    changes: asObject(payload.changes),
    reason: stringValue(payload.reason),
    stack: asObject(payload.stack),
    beforeSha: stringValue(payload.before),
    afterSha: stringValue(payload.after),
    label: label
      ? {
          name: stringValue(label.name),
          color: stringValue(label.color),
          description: stringValue(label.description),
        }
      : null,
    assignee: actorFrom(payload.assignee),
    requestedReviewer: actorFrom(payload.requested_reviewer),
    requestedTeam: team
      ? {
          id: numberValue(team.id),
          name: stringValue(team.name),
          slug: stringValue(team.slug),
        }
      : null,
    milestone: milestone
      ? {
          id: numberValue(milestone.id),
          title: stringValue(milestone.title),
          state: stringValue(milestone.state),
        }
      : null,
  };
}

const SUPPORTED_ACTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  pull_request: [
    "assigned",
    "auto_merge_disabled",
    "auto_merge_enabled",
    "closed",
    "converted_to_draft",
    "demilestoned",
    "dequeued",
    "edited",
    "enqueued",
    "labeled",
    "locked",
    "milestoned",
    "opened",
    "ready_for_review",
    "reopened",
    "review_request_removed",
    "review_requested",
    "stacked",
    "synchronize",
    "unassigned",
    "unlabeled",
    "unlocked",
  ],
  pull_request_review: ["dismissed", "edited", "submitted"],
  pull_request_review_comment: ["created", "deleted", "edited"],
  issue_comment: ["created", "deleted", "edited", "pinned", "unpinned"],
  check_run: ["completed", "created", "requested_action", "rerequested"],
  check_suite: ["completed", "requested", "rerequested"],
  workflow_run: ["completed", "in_progress", "requested"],
};

function hasEditedBodyChange(value: unknown): boolean {
  const body = asObject(asObject(value)?.body);
  return body !== null && Object.hasOwn(body, "from");
}

function pullRequestActionIsValid(action: string, payload: JsonObject): boolean {
  switch (action) {
    case "synchronize":
      return stringValue(payload.before) !== null && stringValue(payload.after) !== null;
    case "auto_merge_disabled":
    case "dequeued":
      return stringValue(payload.reason) !== null;
    case "review_requested":
    case "review_request_removed":
      return (
        Object.hasOwn(payload, "requested_reviewer") || Object.hasOwn(payload, "requested_team")
      );
    case "edited":
      return asObject(payload.changes) !== null;
    default:
      return true;
  }
}

function actionIsSupported(eventName: string, action: string | null): boolean {
  if (eventName === "status") return action === null;
  return action !== null && (SUPPORTED_ACTIONS[eventName]?.includes(action) ?? false);
}

function pullRequestMarkerMatches(
  value: unknown,
  repositoryFullName: string,
  pullRequestNumber: number,
): boolean {
  const markerUrl = stringValue(asObject(value)?.url);
  if (!markerUrl) return false;
  try {
    const url = new URL(markerUrl);
    return (
      url.hostname === "api.github.com" &&
      url.pathname.toLowerCase() ===
        `/repos/${repositoryFullName}/pulls/${pullRequestNumber}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function normalizeWebhook(input: NormalizeWebhookInput): GitHubEvent | null {
  const payload = asObject(input.payload);
  const repository = asObject(payload?.repository);
  const fullName = stringValue(repository?.full_name);
  const repositoryId = numberValue(repository?.id);
  const action = stringValue(payload?.action);
  if (!payload || !repository || !fullName || repositoryId === null) return null;
  if (!actionIsSupported(input.eventName, action)) return null;

  const base = {
    version: 1 as const,
    deliveryId: input.deliveryId,
    event: input.eventName,
    action,
    repository: {
      id: numberValue(repository.id),
      fullName,
      url: stringValue(repository.html_url),
    },
    actor: actorFrom(payload.sender),
    receivedAt: input.receivedAt ?? null,
  };

  if (input.eventName === "pull_request") {
    const pullRequest = pullRequestFrom(payload.pull_request, repositoryId);
    const number = numberValue(pullRequest?.number);
    const head = asObject(pullRequest?.head);
    if (
      !pullRequest ||
      number === null ||
      numberValue(payload.number) !== number ||
      !action ||
      !pullRequestActionIsValid(action, payload)
    ) {
      return null;
    }
    return {
      ...base,
      pullRequestNumbers: [number],
      headSha: stringValue(head?.sha),
      occurredAt:
        input.receivedAt ??
        stringValue(pullRequest.updatedAt) ??
        stringValue(pullRequest.createdAt) ??
        null,
      details: { pullRequest, action: pullRequestActionDetails(payload) },
    };
  }

  if (input.eventName === "pull_request_review") {
    const pullRequest = pullRequestFrom(payload.pull_request, repositoryId);
    const review = reviewFrom(payload.review);
    const number = numberValue(pullRequest?.number);
    const head = asObject(pullRequest?.head);
    if (
      !pullRequest ||
      !review ||
      number === null ||
      (action === "edited" && !hasEditedBodyChange(payload.changes))
    ) {
      return null;
    }
    return {
      ...base,
      pullRequestNumbers: [number],
      headSha: stringValue(head?.sha),
      occurredAt:
        action === "submitted"
          ? (stringValue(review.submittedAt) ?? input.receivedAt ?? null)
          : (input.receivedAt ?? stringValue(review.submittedAt) ?? null),
      details: { pullRequest, review, changes: asObject(payload.changes) },
    };
  }

  if (input.eventName === "pull_request_review_comment") {
    const pullRequest = pullRequestFrom(payload.pull_request, repositoryId);
    const comment = commentFrom(payload.comment);
    const number = numberValue(pullRequest?.number);
    const head = asObject(pullRequest?.head);
    if (
      !pullRequest ||
      !comment ||
      number === null ||
      (action === "edited" && !hasEditedBodyChange(payload.changes))
    ) {
      return null;
    }
    return {
      ...base,
      pullRequestNumbers: [number],
      headSha: stringValue(head?.sha),
      occurredAt:
        action === "deleted"
          ? (input.receivedAt ?? stringValue(comment.updatedAt) ?? null)
          : (stringValue(comment.updatedAt) ??
            stringValue(comment.createdAt) ??
            input.receivedAt ??
            null),
      details: { pullRequest, comment, changes: asObject(payload.changes) },
    };
  }

  if (input.eventName === "check_run") {
    const check = checkRunFrom(payload.check_run, repositoryId);
    const requestedAction = stringValue(asObject(payload.requested_action)?.identifier);
    if (!check || (action === "requested_action" && !requestedAction)) return null;
    return {
      ...base,
      pullRequestNumbers: Array.isArray(check.pullRequestNumbers)
        ? (check.pullRequestNumbers as ReadonlyArray<number>)
        : [],
      headSha: stringValue(check.headSha),
      occurredAt:
        action === "completed"
          ? (stringValue(check.completedAt) ?? input.receivedAt ?? null)
          : (input.receivedAt ?? stringValue(check.startedAt) ?? null),
      details: {
        check,
        requestedAction,
      },
    };
  }

  if (input.eventName === "check_suite") {
    const suite = asObject(payload.check_suite);
    const id = numberValue(suite?.id);
    const status = stringValue(suite?.status);
    const headSha = stringValue(suite?.head_sha);
    if (!suite || id === null || !status || !headSha) return null;
    const checkSuite = {
      id,
      status,
      conclusion: stringValue(suite.conclusion),
      headSha,
      url: stringValue(suite.url),
      beforeSha: stringValue(suite.before),
      afterSha: stringValue(suite.after),
      createdAt: stringValue(suite.created_at),
      updatedAt: stringValue(suite.updated_at),
      pullRequestNumbers: pullRequestNumbersFrom(suite.pull_requests, repositoryId),
    };
    return {
      ...base,
      pullRequestNumbers: checkSuite.pullRequestNumbers,
      headSha,
      occurredAt: input.receivedAt ?? checkSuite.updatedAt ?? checkSuite.createdAt ?? null,
      details: { checkSuite },
    };
  }

  if (input.eventName === "workflow_run") {
    const run = asObject(payload.workflow_run);
    const id = numberValue(run?.id);
    const workflowId = numberValue(run?.workflow_id);
    const name = stringValue(run?.name);
    const status = stringValue(run?.status);
    const headSha = stringValue(run?.head_sha);
    if (!run || id === null || workflowId === null || !name || !status || !headSha) {
      return null;
    }
    const workflowRun = {
      id,
      workflowId,
      name,
      runNumber: numberValue(run.run_number),
      runAttempt: numberValue(run.run_attempt),
      triggerEvent: stringValue(run.event),
      status,
      conclusion: stringValue(run.conclusion),
      headSha,
      url: stringValue(run.html_url),
      createdAt: stringValue(run.created_at),
      updatedAt: stringValue(run.updated_at),
      pullRequestNumbers: pullRequestNumbersFrom(run.pull_requests, repositoryId),
    };
    return {
      ...base,
      pullRequestNumbers: workflowRun.pullRequestNumbers,
      headSha,
      occurredAt: input.receivedAt ?? workflowRun.updatedAt ?? workflowRun.createdAt ?? null,
      details: { workflowRun },
    };
  }

  if (input.eventName === "status") {
    const id = numberValue(payload.id);
    const sha = stringValue(payload.sha);
    const state = stringValue(payload.state);
    const context = stringValue(payload.context);
    if (id === null || !sha || !state || !context) return null;
    const status = {
      id,
      state,
      context,
      description: stringValue(payload.description),
      targetUrl: stringValue(payload.target_url),
      createdAt: stringValue(payload.created_at),
    };
    return {
      ...base,
      pullRequestNumbers: [],
      headSha: sha,
      occurredAt: status.createdAt ?? null,
      details: { status },
    };
  }

  const issuePayload = asObject(payload.issue);
  if (input.eventName !== "issue_comment") {
    return null;
  }

  const issue = issueFrom(issuePayload);
  const comment = commentFrom(payload.comment);
  if (!issue || !comment || (action === "edited" && !hasEditedBodyChange(payload.changes))) {
    return null;
  }
  const pullRequestNumber = numberValue(issue.number);
  if (
    pullRequestNumber === null ||
    !pullRequestMarkerMatches(issuePayload?.pull_request, fullName, pullRequestNumber)
  ) {
    return null;
  }

  return {
    ...base,
    pullRequestNumbers: [pullRequestNumber],
    headSha: null,
    occurredAt:
      action === "created" || action === "edited"
        ? (stringValue(comment.updatedAt) ??
          stringValue(comment.createdAt) ??
          input.receivedAt ??
          null)
        : (input.receivedAt ?? stringValue(comment.updatedAt) ?? null),
    details: { issue, comment, changes: asObject(payload.changes) },
  };
}
