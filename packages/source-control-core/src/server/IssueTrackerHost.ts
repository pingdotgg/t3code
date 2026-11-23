/**
 * What a standalone tracker package may ask of the server it runs in: the credential the user
 * saved in Settings. Git-host trackers never need it; their CLIs carry their own credentials.
 */
import type { IssueTrackerAccountId, IssueTrackerKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { IssueTrackerApi, IssueTrackerError } from "./IssueTracker.ts";

export class IssueTrackerHost extends Context.Service<
  IssueTrackerHost,
  {
    readonly credentials: {
      /** Read fresh on each call, so a credential saved in Settings applies without a restart. */
      readonly get: (
        tracker: IssueTrackerKind,
      ) => Effect.Effect<Option.Option<string>, IssueTrackerError>;
    };
  }
>()("@t3tools/source-control-core/server/IssueTrackerHost") {}

/**
 * The account a standalone tracker call is made as, set by the server around each call; null is
 * the tracker's first account. A tracker never reads it: `credentials.get` does.
 */
export const IssueTrackerAccount = Context.Reference<IssueTrackerAccountId | null>(
  "@t3tools/source-control-core/server/IssueTrackerHost/IssueTrackerAccount",
  { defaultValue: () => null },
);

/** The tracker with every call made as one account, so no call site can forget to name it. */
export function asIssueTrackerAccount(
  api: IssueTrackerApi,
  accountId: IssueTrackerAccountId | null,
): IssueTrackerApi {
  if (accountId === null) return api;
  const as = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, IssueTrackerAccount, accountId);
  const {
    getIssueLink,
    issueScope,
    create,
    comment,
    update,
    setState,
    setReaction,
    listTemplates,
    listCandidates,
  } = api;
  // Every key is required here, so a method added to IssueTrackerApi fails to compile until it
  // is wrapped instead of silently running as the first account.
  const wrapped: { readonly [K in keyof IssueTrackerApi]-?: IssueTrackerApi[K] | undefined } = {
    kind: api.kind,
    capabilities: api.capabilities,
    getViewer: (input) => as(api.getViewer(input)),
    listIssues: (input) => as(api.listIssues(input)),
    getIssue: (input) => as(api.getIssue(input)),
    getComments: (input) => as(api.getComments(input)),
    getIssueLink: getIssueLink && ((input) => as(getIssueLink(input))),
    issueScope: issueScope && ((input) => as(issueScope(input))),
    create: create && ((input) => as(create(input))),
    comment: comment && ((input) => as(comment(input))),
    update: update && ((input) => as(update(input))),
    setState: setState && ((input) => as(setState(input))),
    setReaction: setReaction && ((input) => as(setReaction(input))),
    listTemplates: listTemplates && ((input) => as(listTemplates(input))),
    listCandidates: listCandidates && ((input) => as(listCandidates(input))),
  };
  return Object.fromEntries(
    Object.entries(wrapped).filter(([, value]) => value !== undefined),
  ) as unknown as IssueTrackerApi;
}
