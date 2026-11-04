import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestContextMetadata } from "./composerContext.ts";

/** Providers that fill the local mention index for `#` (PRs) and `@` (threads). */
export const MentionIndexProviderId = Schema.Literals(["pull-request", "thread"]);
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

export const MentionIndexHit = Schema.Struct({
  providerId: MentionIndexProviderId,
  itemKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  score: Schema.Number,
  pullRequest: Schema.optionalKey(MentionIndexPullRequestPayload),
  thread: Schema.optionalKey(MentionIndexThreadPayload),
});
export type MentionIndexHit = typeof MentionIndexHit.Type;

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
