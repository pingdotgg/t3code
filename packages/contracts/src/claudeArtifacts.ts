import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/** One claude.ai Artifact, as the Artifact tool's list reported it. The title is third-party text. */
export const ClaudeArtifact = Schema.Struct({
  title: Schema.String,
  /** Always an https://claude.ai artifact link. */
  url: Schema.String,
  owner: Schema.Literals(["mine", "shared"]),
  /** The list's kind tags, such as "web page", "Docs" or "Data". */
  kinds: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  /** YYYY-MM-DD, when the list gave one. */
  updatedOn: Schema.optional(Schema.String),
});
export type ClaudeArtifact = typeof ClaudeArtifact.Type;

/** `idle` has never been fetched; `signedOut` needs a claude.ai login for that account. */
export const ClaudeArtifactAccountStatus = Schema.Literals(["idle", "ok", "error", "signedOut"]);
export type ClaudeArtifactAccountStatus = typeof ClaudeArtifactAccountStatus.Type;

/** One Claude provider instance (account) and the last list fetched for it. */
export const ClaudeArtifactAccount = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.String,
  status: ClaudeArtifactAccountStatus,
  message: Schema.optional(Schema.String),
  /** ISO time of the last finished fetch, successful or not. */
  fetchedAt: Schema.optional(Schema.String),
  /** The last successful list; kept when a later fetch fails. */
  artifacts: Schema.Array(ClaudeArtifact),
  /** List lines that did not parse and were left out. */
  skippedLines: Schema.Number,
});
export type ClaudeArtifactAccount = typeof ClaudeArtifactAccount.Type;

export const ClaudeArtifactsSnapshot = Schema.Struct({
  accounts: Schema.Array(ClaudeArtifactAccount),
});
export type ClaudeArtifactsSnapshot = typeof ClaudeArtifactsSnapshot.Type;

/** Omit `instanceId` to refresh every enabled Claude account. */
export const ClaudeArtifactsRefreshInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
});
export type ClaudeArtifactsRefreshInput = typeof ClaudeArtifactsRefreshInput.Type;

export class ClaudeArtifactsError extends Schema.TaggedError<ClaudeArtifactsError>()(
  "ClaudeArtifactsError",
  {
    reason: Schema.Literals(["unknownInstance"]),
    message: Schema.String,
  },
) {}
