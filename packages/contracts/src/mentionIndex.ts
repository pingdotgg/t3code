import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestContextMetadata } from "./composerContext.ts";

/** Providers that fill the local mention index for `#`/`@pr:`, `@thread:`, `@jira:`, `@issue:`, and `@figma:`. */
export const MentionIndexProviderId = Schema.Literals([
  "pull-request",
  "thread",
  "jira",
  "issue",
  "figma",
]);
export type MentionIndexProviderId = typeof MentionIndexProviderId.Type;

export const MentionIndexPullRequestPayload = Schema.Struct({
  ...PullRequestContextMetadata.fields,
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
});
export type MentionIndexPullRequestPayload = typeof MentionIndexPullRequestPayload.Type;

export const MentionIndexThreadPayload = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  projectId: ProjectId,
});
export type MentionIndexThreadPayload = typeof MentionIndexThreadPayload.Type;

export const MentionIndexJiraPayload = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  projectKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  status: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type MentionIndexJiraPayload = typeof MentionIndexJiraPayload.Type;

export const MentionIndexIssuePayload = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  repository: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  state: Schema.Literals(["open", "closed"]),
  projectId: ProjectId,
});
export type MentionIndexIssuePayload = typeof MentionIndexIssuePayload.Type;

export const MentionIndexFigmaPayload = Schema.Struct({
  fileKey: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  hasThumbnail: Schema.Boolean,
});
export type MentionIndexFigmaPayload = typeof MentionIndexFigmaPayload.Type;

export const MentionIndexHit = Schema.Struct({
  providerId: MentionIndexProviderId,
  itemKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  score: Schema.Number,
  pullRequest: Schema.optionalKey(MentionIndexPullRequestPayload),
  thread: Schema.optionalKey(MentionIndexThreadPayload),
  jira: Schema.optionalKey(MentionIndexJiraPayload),
  issue: Schema.optionalKey(MentionIndexIssuePayload),
  figma: Schema.optionalKey(MentionIndexFigmaPayload),
});
export type MentionIndexHit = typeof MentionIndexHit.Type;

export const MentionIndexThumbnailInput = Schema.Struct({
  projectId: ProjectId,
  providerId: Schema.Literal("figma"),
  itemKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type MentionIndexThumbnailInput = typeof MentionIndexThumbnailInput.Type;

export const MentionIndexThumbnailResult = Schema.Union([
  Schema.TaggedStruct("Present", {
    mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    /** Base64-encoded image bytes; keep payloads small (syncer stores compressed previews). */
    dataBase64: Schema.String.check(Schema.isMaxLength(400_000)),
  }),
  Schema.TaggedStruct("Missing", {}),
]);
export type MentionIndexThumbnailResult = typeof MentionIndexThumbnailResult.Type;

export const MentionIndexSearchInput = Schema.Struct({
  projectId: ProjectId,
  providers: Schema.optionalKey(Schema.Array(MentionIndexProviderId).check(Schema.isMaxLength(8))),
  query: Schema.String.check(Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type MentionIndexSearchInput = typeof MentionIndexSearchInput.Type;

export const MentionIndexSyncStatus = Schema.Literals(["ready", "syncing", "empty", "error"]);
export type MentionIndexSyncStatus = typeof MentionIndexSyncStatus.Type;

export const MentionIndexSearchResult = Schema.Struct({
  hits: Schema.Array(MentionIndexHit).check(Schema.isMaxLength(50)),
  status: MentionIndexSyncStatus,
  /** Wall-clock ms when this project scope was last replaced; absent if never synced. */
  syncedAt: Schema.optionalKey(Schema.Finite),
  detail: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type MentionIndexSearchResult = typeof MentionIndexSearchResult.Type;

export const MentionIndexFigmaBrowseInput = Schema.Struct({
  /** When set, resolves project-scoped `mentionIndex.figma.serverName` as a fallback. */
  projectId: Schema.optionalKey(ProjectId),
  serverName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type MentionIndexFigmaBrowseInput = typeof MentionIndexFigmaBrowseInput.Type;

export const MentionIndexFigmaTeam = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type MentionIndexFigmaTeam = typeof MentionIndexFigmaTeam.Type;

export const MentionIndexFigmaBrowseTeamsResult = Schema.Struct({
  teams: Schema.Array(MentionIndexFigmaTeam).check(Schema.isMaxLength(100)),
  detail: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type MentionIndexFigmaBrowseTeamsResult = typeof MentionIndexFigmaBrowseTeamsResult.Type;

export const MentionIndexFigmaListProjectsInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  teamId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  serverName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type MentionIndexFigmaListProjectsInput = typeof MentionIndexFigmaListProjectsInput.Type;

export const MentionIndexFigmaBrowseProject = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type MentionIndexFigmaBrowseProject = typeof MentionIndexFigmaBrowseProject.Type;

export const MentionIndexFigmaListProjectsResult = Schema.Struct({
  projects: Schema.Array(MentionIndexFigmaBrowseProject).check(Schema.isMaxLength(200)),
  detail: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type MentionIndexFigmaListProjectsResult = typeof MentionIndexFigmaListProjectsResult.Type;
