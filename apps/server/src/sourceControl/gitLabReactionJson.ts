import type { IssueReaction, IssueReactionContent } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? null : text;
};

const GITLAB_AWARD_BY_CONTENT: Readonly<Record<IssueReactionContent, string>> = {
  "thumbs-up": "thumbsup",
  "thumbs-down": "thumbsdown",
  laugh: "laughing",
  hooray: "tada",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

const CONTENT_BY_GITLAB_AWARD = Object.fromEntries(
  Object.entries(GITLAB_AWARD_BY_CONTENT).map(([content, name]) => [name, content]),
) as Readonly<Record<string, IssueReactionContent>>;

export function gitLabAwardName(content: IssueReactionContent): string {
  return GITLAB_AWARD_BY_CONTENT[content];
}

export const GitLabAwardNodesSchema = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      nodes: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                name: Schema.optional(Schema.NullOr(Schema.String)),
                user: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({ username: Schema.optional(Schema.NullOr(Schema.String)) }),
                  ),
                ),
              }),
            ),
          ),
        ),
      ),
    }),
  ),
);

export function toGitLabReactions(
  nodes: typeof GitLabAwardNodesSchema.Type,
  viewer: string | null,
): ReadonlyArray<IssueReaction> {
  const normalizedViewer = viewer?.toLowerCase() ?? null;
  const groups = new Map<
    IssueReactionContent,
    { count: number; actors: string[]; viewer: boolean }
  >();
  for (const node of nodes?.nodes ?? []) {
    const content = CONTENT_BY_GITLAB_AWARD[trimmed(node?.name)?.toLowerCase() ?? ""];
    const username = trimmed(node?.user?.username);
    if (content === undefined || username === null) continue;
    const group = groups.get(content) ?? { count: 0, actors: [], viewer: false };
    group.count++;
    if (normalizedViewer !== null && username.toLowerCase() === normalizedViewer) {
      group.viewer = true;
    } else {
      group.actors.push(username);
    }
    groups.set(content, group);
  }
  return [...groups].map(([content, group]) => ({
    content,
    count: group.count,
    actors: group.actors,
    viewerHasReacted: group.viewer,
  }));
}

const RawAwardSchema = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ username: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
const decodeAwardList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeAward = Schema.decodeUnknownExit(RawAwardSchema);

export function decodeOwnGitLabAwardPageJson(
  raw: string,
  input: { readonly content: IssueReactionContent; readonly viewer: string },
): Result.Result<{ readonly id: number | null; readonly rawCount: number }, unknown> {
  const decoded = decodeAwardList(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const name = gitLabAwardName(input.content);
  for (const entry of decoded.success) {
    const award = decodeAward(entry);
    if (!Exit.isSuccess(award)) continue;
    if (trimmed(award.value.name)?.toLowerCase() !== name) continue;
    if (trimmed(award.value.user?.username) !== input.viewer) continue;
    return Result.succeed({ id: award.value.id, rawCount: decoded.success.length });
  }
  return Result.succeed({ id: null, rawCount: decoded.success.length });
}
