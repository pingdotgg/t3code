import * as DateTime from "effect/DateTime";
import type {
  PullRequestActor,
  PullRequestComment,
  PullRequestOverviewThread,
  PullRequestReviewDecision,
  PullRequestState,
  PullRequestThreadComment,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestSummary,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { definition, patchUrl } from "../shared/definition.ts";
import {
  latestBody,
  latestRevision,
  type RadicleComment,
  type RadiclePatch,
  type RadicleRevision,
} from "./radiclePatchJson.ts";

export interface PatchContext {
  readonly rid: string;
  readonly defaultBranch: string;
  readonly aliases: ReadonlyMap<string, string>;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** `z6MknmK…Zvq7bUz`, the way `rad` shortens a node ID. */
export function shortNodeId(did: string): string {
  const nid = did.replace(/^did:key:/u, "");
  return nid.length > 16 ? `${nid.slice(0, 7)}…${nid.slice(-7)}` : nid;
}

const asDid = (author: string) => (author.startsWith("did:") ? author : `did:key:${author}`);

/** What lists show for a peer: the alias the node knows it by, else its short node ID. */
export function radicleLogin(author: string, aliases: ReadonlyMap<string, string>): string {
  const did = asDid(author);
  return aliases.get(did) ?? shortNodeId(did);
}

export function radicleActor(
  author: string,
  aliases: ReadonlyMap<string, string>,
): PullRequestActor {
  const login = radicleLogin(author, aliases);
  return { login, name: login, avatarUrl: null };
}

export function pullRequestState(patch: RadiclePatch): PullRequestState {
  return patch.status === "merged" ? "merged" : patch.status === "archived" ? "closed" : "open";
}

function reviewDecision(patch: RadiclePatch): PullRequestReviewDecision | null {
  const verdicts = Object.values(latestRevision(patch).reviews).map((review) => review?.verdict);
  if (verdicts.includes("reject")) return "changes-requested";
  if (verdicts.includes("accept")) return "approved";
  return null;
}

export const headBranch = (patch: RadiclePatch) => `patches/${patch.id}`;

export function toChangeRequest(patch: RadiclePatch, context: PatchContext): ProviderChangeRequest {
  return {
    number: patch.number,
    title: patch.title,
    url: patchUrl({ rid: context.rid, patch: patch.id }),
    author: radicleActor(patch.author, context.aliases),
    headBranch: headBranch(patch),
    baseBranch: context.defaultBranch,
    state: pullRequestState(patch),
    isDraft: patch.status === "draft",
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: iso(patch.createdAt),
    updatedAt: iso(patch.updatedAt),
    ...(patch.merges[0] ? { mergedAt: iso(patch.merges[0].timestamp) } : {}),
    reviewRequestLogins: [],
    labels: patch.labels.map((name) => ({ name, color: null })),
    reviewDecision: reviewDecision(patch),
  };
}

export function toSummary(
  patch: RadiclePatch,
  context: PatchContext,
): ProviderChangeRequestSummary {
  const changeRequest = toChangeRequest(patch, context);
  return {
    number: changeRequest.number,
    title: changeRequest.title,
    url: changeRequest.url,
    headBranch: changeRequest.headBranch,
    baseBranch: changeRequest.baseBranch,
    state: changeRequest.state,
    isDraft: changeRequest.isDraft,
    updatedAt: changeRequest.updatedAt,
    author: changeRequest.author,
    reviewDecision: changeRequest.reviewDecision,
    headSha: latestRevision(patch).oid,
    ...(patch.merges[0] ? { mergedAt: iso(patch.merges[0].timestamp) } : {}),
  };
}

/**
 * Delegates can merge and change any patch; an author can draft, ready, close and reopen their
 * own. Everyone can comment and review, since Radicle signs rather than gates them.
 */
export function viewerPermissions(input: {
  readonly patch: RadiclePatch | null;
  readonly viewer: string;
  readonly delegates: ReadonlyArray<string>;
}): PullRequestViewerPermissions {
  const isDelegate = input.delegates.includes(input.viewer);
  const isAuthor = input.patch?.author === input.viewer;
  return {
    actions: [...definition.changeRequestActions].filter(
      (action) => isDelegate || (isAuthor && action !== "merge"),
    ),
    comment: true,
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
    requestReviewers: false,
    editChangeRequest: isDelegate || isAuthor,
  };
}

function threadComment(
  id: string,
  comment: RadicleComment,
  aliases: ReadonlyMap<string, string>,
  viewer: string,
): PullRequestThreadComment {
  const first = comment.edits[0];
  const last = comment.edits.at(-1);
  return {
    id,
    author: radicleActor(comment.author, aliases),
    body: comment.body,
    createdAt: iso(first?.timestamp ?? 0),
    ...(last && first && last.timestamp !== first.timestamp
      ? { editedAt: iso(last.timestamp) }
      : {}),
    url: null,
    canEdit: asDid(comment.author) === viewer,
  };
}

/** The comment a reply chain starts from; a chain that leaves the revision ends at its last hop. */
function rootOf(id: string, comments: RadicleRevision["discussion"]["comments"]): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = comments[current]?.replyTo;
    if (!parent || !comments[parent]) return current;
    current = parent;
  }
  return current;
}

/**
 * Each top-level comment and its replies, in the order they were posted. Comments on revisions
 * before the latest are outdated, as review comments on a superseded diff are elsewhere.
 */
export function overviewThreads(
  patch: RadiclePatch,
  aliases: ReadonlyMap<string, string>,
  viewer: string,
): ReadonlyArray<PullRequestOverviewThread> {
  const latest = latestRevision(patch);
  return patch.revisions.flatMap((revision) => {
    const { comments, timeline } = revision.discussion;
    const threads = new Map<string, Array<PullRequestThreadComment>>();
    for (const id of timeline) {
      const comment = comments[id];
      if (!comment) continue;
      const root = rootOf(id, comments);
      const thread = threads.get(root) ?? [];
      thread.push(threadComment(id, comment, aliases, viewer));
      threads.set(root, thread);
    }
    return [...threads].map(([root, thread]) => ({
      id: root,
      path: null,
      line: null,
      side: "right" as const,
      isResolved: comments[root]?.resolved === true,
      isOutdated: revision.id !== latest.id,
      comments: thread,
      commentCount: thread.length,
      canResolve: false,
    }));
  });
}

/** Reviews read as comments with a verdict, newest revision's last. */
export function reviewComments(
  patch: RadiclePatch,
  aliases: ReadonlyMap<string, string>,
): ReadonlyArray<PullRequestComment> {
  return patch.revisions.flatMap((revision) =>
    Object.values(revision.reviews).flatMap((review) =>
      review
        ? [
            {
              id: review.id,
              kind: "review" as const,
              author: radicleActor(review.author.id, aliases),
              body: latestBody(review.summary),
              createdAt: iso(review.timestamp),
              url: null,
              path: null,
              reviewState:
                review.verdict === "accept"
                  ? "APPROVED"
                  : review.verdict === "reject"
                    ? "CHANGES_REQUESTED"
                    : "COMMENTED",
            },
          ]
        : [],
    ),
  );
}

/** The revision holding comment `id`, which `rad patch comment` must be pointed at. */
export function revisionOfComment(patch: RadiclePatch, id: string): RadicleRevision | null {
  return patch.revisions.find((revision) => revision.discussion.comments[id]) ?? null;
}
