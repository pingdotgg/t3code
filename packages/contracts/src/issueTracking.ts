import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueProviderKind } from "./issue.ts";
import { IssueTrackerProjectBinding } from "./settings.ts";

export const IssueTrackerProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type IssueTrackerProject = typeof IssueTrackerProject.Type;

export const IssueTrackerAccount = Schema.Struct({
  credentialId: TrimmedNonEmptyString,
  status: Schema.Literals(["authenticated", "unauthenticated", "unverified"]),
  accountName: TrimmedNonEmptyString,
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  projects: Schema.Array(IssueTrackerProject),
});
export type IssueTrackerAccount = typeof IssueTrackerAccount.Type;

export const IssueTrackerEnvironmentAccount = Schema.Struct({
  status: Schema.Literals(["authenticated", "unauthenticated", "unverified"]),
  accountName: TrimmedNonEmptyString,
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  projects: Schema.Array(IssueTrackerProject),
});
export type IssueTrackerEnvironmentAccount = typeof IssueTrackerEnvironmentAccount.Type;

export const IssueTrackerConnection = Schema.Struct({
  status: Schema.Literals(["authenticated", "unauthenticated", "unverified"]),
  hasStoredToken: Schema.Boolean,
  accountName: Schema.NullOr(TrimmedNonEmptyString),
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  projects: Schema.Array(IssueTrackerProject),
  accounts: Schema.Array(IssueTrackerAccount).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  environmentAccount: Schema.optionalKey(IssueTrackerEnvironmentAccount),
});
export type IssueTrackerConnection = typeof IssueTrackerConnection.Type;

export const IssueTrackerStatusInput = Schema.Struct({ provider: IssueProviderKind });
export type IssueTrackerStatusInput = typeof IssueTrackerStatusInput.Type;

export const IssueTrackerConnectInput = Schema.Struct({
  provider: IssueProviderKind,
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type IssueTrackerConnectInput = typeof IssueTrackerConnectInput.Type;

export const IssueTrackerDisconnectInput = Schema.Struct({
  provider: IssueProviderKind,
  credentialId: TrimmedNonEmptyString,
});
export type IssueTrackerDisconnectInput = typeof IssueTrackerDisconnectInput.Type;

export const IssueTrackerBindInput = Schema.Struct({
  provider: IssueProviderKind,
  projectId: ProjectId,
  binding: Schema.NullOr(IssueTrackerProjectBinding),
});
export type IssueTrackerBindInput = typeof IssueTrackerBindInput.Type;

export class IssueTrackingError extends Schema.TaggedError<IssueTrackingError>()(
  "IssueTrackingError",
  {
    operation: Schema.Literals(["status", "connect", "disconnect", "bind"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Issue tracking ${this.operation} failed: ${this.detail}`;
  }
}
