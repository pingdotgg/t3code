/** Shared agent references used by both agent documents and thread metadata. */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const AgentProfileIdSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
);

export const AgentProfileId = AgentProfileIdSchema.pipe(Schema.brand("AgentProfileId"));
export type AgentProfileId = typeof AgentProfileId.Type;

export const AgentProfileScope = Schema.Literals(["environment", "project"]);
export type AgentProfileScope = typeof AgentProfileScope.Type;

export const AgentProfileRevision = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("AgentProfileRevision"));
export type AgentProfileRevision = typeof AgentProfileRevision.Type;

/** Unpinned profile identity used when selecting a profile. */
export const AgentProfileLocator = Schema.Struct({
  id: AgentProfileId,
  scope: AgentProfileScope,
});
export type AgentProfileLocator = typeof AgentProfileLocator.Type;

/** Revision-pinned profile identity retained by a thread/run. */
export const AgentProfileRef = Schema.Struct({
  ...AgentProfileLocator.fields,
  revision: AgentProfileRevision,
});
export type AgentProfileRef = typeof AgentProfileRef.Type;

export const AgentDocumentRef = Schema.Struct({
  id: AgentProfileId,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type AgentDocumentRef = typeof AgentDocumentRef.Type;

export const AgentRuleRef = AgentDocumentRef;
export type AgentRuleRef = typeof AgentRuleRef.Type;
