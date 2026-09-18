import type { PullRequestReaction, PullRequestReactionContent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? null : text;
};

const REACTORS_PER_GROUP = 10;

export const GITHUB_REACTION_GROUPS_FIELDS = `reactionGroups {
  content
  viewerHasReacted
  reactors(first: ${REACTORS_PER_GROUP}) {
    totalCount
    nodes {
      ... on User { login }
      ... on Bot { login }
      ... on Organization { login }
      ... on Mannequin { login }
    }
  }
}`;

const REACTION_CONTENT_BY_GITHUB: Readonly<Record<string, PullRequestReactionContent>> = {
  THUMBS_UP: "thumbs-up",
  THUMBS_DOWN: "thumbs-down",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

const GITHUB_REACTION_BY_CONTENT: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "THUMBS_UP",
  "thumbs-down": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

export function gitHubReactionContent(content: PullRequestReactionContent): string {
  return GITHUB_REACTION_BY_CONTENT[content];
}

export const GitHubReactionGroupsSchema = Schema.optional(
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        viewerHasReacted: Schema.optional(Schema.Boolean),
        reactors: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              totalCount: Schema.optional(Schema.Int),
              nodes: Schema.optional(
                Schema.NullOr(
                  Schema.Array(
                    Schema.NullOr(
                      Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) }),
                    ),
                  ),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
);

export function toGitHubReactions(
  groups: typeof GitHubReactionGroupsSchema.Type,
  viewer: string | null,
): ReadonlyArray<PullRequestReaction> {
  const normalizedViewer = viewer?.toLowerCase() ?? null;
  const reactions: PullRequestReaction[] = [];
  for (const group of groups ?? []) {
    const content = REACTION_CONTENT_BY_GITHUB[trimmed(group.content)?.toUpperCase() ?? ""];
    if (content === undefined) continue;
    const logins = (group.reactors?.nodes ?? []).flatMap((node) => trimmed(node?.login) ?? []);
    const count = Math.max(group.reactors?.totalCount ?? logins.length, logins.length);
    if (count <= 0) continue;
    const actors =
      normalizedViewer === null
        ? logins
        : logins.filter((login) => login.toLowerCase() !== normalizedViewer);
    reactions.push({ content, count, actors, viewerHasReacted: group.viewerHasReacted === true });
  }
  return reactions;
}

export const ADD_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) { subject { id } }
}`;

export const REMOVE_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) { subject { id } }
}`;
