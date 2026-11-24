import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { formatConjunctionList } from "./listFormat.ts";
import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestReaction,
  PullRequestReactionContent,
} from "@t3tools/contracts";

export function canReactPullRequestComment(
  detail: Pick<PullRequestDetail, "provider" | "capabilities">,
  comment: Pick<PullRequestComment, "kind">,
): boolean {
  return (
    detail.capabilities.reactions === true &&
    !(detail.provider === "gitcafe" && comment.kind === "review")
  );
}

export const PULL_REQUEST_REACTION_ORDER: ReadonlyArray<PullRequestReactionContent> = [
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
];

const REACTION_EMOJI: Record<PullRequestReactionContent, string> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

const REACTION_NAME: Record<PullRequestReactionContent, string> = {
  "thumbs-up": msg("thumbs up", { $context: "reaction emoji name" }),
  "thumbs-down": msg("thumbs down", { $context: "reaction emoji name" }),
  laugh: msg("laugh", { $context: "reaction emoji name" }),
  hooray: msg("hooray", { $context: "reaction emoji name" }),
  confused: msg("confused", { $context: "reaction emoji name" }),
  heart: msg("heart", { $context: "reaction emoji name" }),
  rocket: msg("rocket", { $context: "reaction emoji name" }),
  eyes: msg("eyes", { $context: "reaction emoji name" }),
};

export function pullRequestReactionEmoji(content: PullRequestReactionContent): string {
  return REACTION_EMOJI[content];
}

export function pullRequestReactionName(
  content: PullRequestReactionContent,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(REACTION_NAME[content]);
}

const NAMED_ACTOR_LIMIT = 3;

function countRemainder(count: number, named: boolean, resolve: MFunctionType): string {
  return named
    ? resolve(msg("{count, plural, one {{count} other} other {{count} others}}", { count }))
    : resolve(msg("{count, plural, one {{count} person} other {{count} people}}", { count }));
}

function reactedWith(
  content: PullRequestReactionContent,
  names: string,
  resolve: MFunctionType,
): string {
  switch (content) {
    case "thumbs-up":
      return resolve(msg("{names} reacted with thumbs up emoji", { names }));
    case "thumbs-down":
      return resolve(msg("{names} reacted with thumbs down emoji", { names }));
    case "laugh":
      return resolve(msg("{names} reacted with laugh emoji", { names }));
    case "hooray":
      return resolve(msg("{names} reacted with hooray emoji", { names }));
    case "confused":
      return resolve(msg("{names} reacted with confused emoji", { names }));
    case "heart":
      return resolve(msg("{names} reacted with heart emoji", { names }));
    case "rocket":
      return resolve(msg("{names} reacted with rocket emoji", { names }));
    case "eyes":
      return resolve(msg("{names} reacted with eyes emoji", { names }));
  }
}

/** Hosts omit the viewer from actors; add You only if count has room, since viewer login is unavailable. */
export function pullRequestReactionTooltip(
  reaction: PullRequestReaction,
  resolve: MFunctionType = mFallback,
  locale = "en",
): string {
  const viewerHasRoom = reaction.actors.length < reaction.count;
  const names =
    reaction.viewerHasReacted && viewerHasRoom
      ? [
          resolve(msg("You", { $context: "the viewer, in a list of people who reacted" })),
          ...reaction.actors,
        ]
      : [...reaction.actors];
  const shown = names.slice(0, Math.min(NAMED_ACTOR_LIMIT, reaction.count));
  const others = Math.max(0, reaction.count - shown.length);
  const parts = [
    ...shown,
    ...(others > 0 ? [countRemainder(others, shown.length > 0, resolve)] : []),
  ];
  return reactedWith(reaction.content, formatConjunctionList(parts, locale, resolve), resolve);
}

/** Changes whenever the host reports different reactions, so pending overlays can reset. */
export function pullRequestReactionsSignature(
  reactions: ReadonlyArray<PullRequestReaction>,
): string {
  return reactions
    .map((reaction) => `${reaction.content}:${reaction.count}:${reaction.viewerHasReacted ? 1 : 0}`)
    .join(" ");
}

/** One toggle awaiting the host. Its identity tells it apart from a later toggle of the same reaction. */
export interface PendingPullRequestReaction {
  readonly reacted: boolean;
}

export function applyPendingPullRequestReactions(
  reactions: ReadonlyArray<PullRequestReaction>,
  pending: ReadonlyMap<PullRequestReactionContent, PendingPullRequestReaction>,
): ReadonlyArray<PullRequestReaction> {
  if (pending.size === 0) return reactions;
  const byContent = new Map(reactions.map((reaction) => [reaction.content, reaction] as const));
  for (const [content, { reacted }] of pending) {
    const current = byContent.get(content);
    if (current === undefined) {
      if (reacted) {
        byContent.set(content, { content, count: 1, actors: [], viewerHasReacted: true });
      }
      continue;
    }
    if (current.viewerHasReacted === reacted) continue;
    const count = current.count + (reacted ? 1 : -1);
    if (count <= 0) byContent.delete(content);
    else byContent.set(content, { ...current, count, viewerHasReacted: reacted });
  }
  return PULL_REQUEST_REACTION_ORDER.flatMap((content) => byContent.get(content) ?? []);
}
