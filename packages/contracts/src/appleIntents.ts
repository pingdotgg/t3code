import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";

export const APPLE_INTENTS_MAX_INDEXED_THREADS = 500;
export const APPLE_INTENTS_MAX_MESSAGE_PREVIEW_CHARS = 200;

export const AppleIntentThreadStatus = Schema.Literals([
  "running",
  "waiting",
  "queued",
  "idle",
  "error",
]);
export type AppleIntentThreadStatus = typeof AppleIntentThreadStatus.Type;

export const AppleIntentEnvironmentRecord = Schema.Struct({
  id: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  isLocal: Schema.Boolean,
  isConnected: Schema.Boolean,
  updatedAt: Schema.String,
});
export type AppleIntentEnvironmentRecord = typeof AppleIntentEnvironmentRecord.Type;

export const AppleIntentProjectRecord = Schema.Struct({
  /** Composite identity `${environmentId}:${projectId}` for Spotlight and AppEntity IDs. */
  id: Schema.String,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  name: Schema.String,
  workspaceRoot: Schema.String,
  repositoryIdentity: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  deepLinkUrl: Schema.String,
});
export type AppleIntentProjectRecord = typeof AppleIntentProjectRecord.Type;

export const AppleIntentThreadRecord = Schema.Struct({
  /** Composite identity `${environmentId}:${threadId}` for Spotlight and AppEntity IDs. */
  id: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  projectName: Schema.String,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  status: AppleIntentThreadStatus,
  hasPendingRequest: Schema.Boolean,
  pendingRequestSummary: Schema.NullOr(Schema.String),
  isPinned: Schema.Boolean,
  isSettled: Schema.Boolean,
  isSnoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(Schema.String),
  lastMessagePreview: Schema.NullOr(Schema.String),
  providerLabel: Schema.NullOr(Schema.String),
  modelLabel: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  deepLinkUrl: Schema.String,
});
export type AppleIntentThreadRecord = typeof AppleIntentThreadRecord.Type;

export const AppleIntentIndexDelta = Schema.Struct({
  environments: Schema.Array(AppleIntentEnvironmentRecord),
  removedEnvironmentIds: Schema.Array(EnvironmentId),
  upsertedProjects: Schema.Array(AppleIntentProjectRecord),
  removedProjectIds: Schema.Array(Schema.String),
  upsertedThreads: Schema.Array(AppleIntentThreadRecord),
  removedThreadIds: Schema.Array(Schema.String),
});
export type AppleIntentIndexDelta = typeof AppleIntentIndexDelta.Type;

export const AppleIntentAuthScheme = Schema.Literals(["Bearer", "DPoP"]);
export type AppleIntentAuthScheme = typeof AppleIntentAuthScheme.Type;

export const AppleIntentAuthCredential = Schema.Struct({
  environmentId: EnvironmentId,
  httpBaseUrl: Schema.String,
  accessToken: Schema.String,
  authScheme: AppleIntentAuthScheme,
  /** Keychain tag or private JWK JSON used when `authScheme === "DPoP"`. */
  dpopKeyRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type AppleIntentAuthCredential = typeof AppleIntentAuthCredential.Type;

export const AppleIntentOnscreenContext = Schema.NullOr(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("thread"),
      environmentId: EnvironmentId,
      threadId: ThreadId,
      title: Schema.String,
      deepLinkUrl: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("project"),
      environmentId: EnvironmentId,
      projectId: ProjectId,
      title: Schema.String,
      deepLinkUrl: Schema.String,
    }),
  ]),
);
export type AppleIntentOnscreenContext = typeof AppleIntentOnscreenContext.Type;

export const AppleIntentStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});
export type AppleIntentStatus = typeof AppleIntentStatus.Type;
