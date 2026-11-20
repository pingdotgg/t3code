import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpClient } from "effect/http";
import type {
  IssueTrackerCredential,
  IssueTrackerError,
  StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";
import * as TwgJiraAuth from "./TwgJiraAuth.ts";

/**
 * The Jira Cloud tracker over its own REST client. Needs the platform HttpClient, the server's
 * `IssueTrackerHost` for what was saved in Settings, and `SourceControlHost` to run TWG. Each
 * operation reads the saved credential once and keeps it, and any TWG session, to its last request.
 */
export const make = Effect.gen(function* () {
  const host = yield* IssueTrackerHost.IssueTrackerHost;
  const twg = yield* TwgJiraAuth.make;
  const context = yield* Effect.context<HttpClient.HttpClient>();

  const tracker = Effect.fn("JiraDriver.tracker")(function* (probed?: IssueTrackerCredential) {
    const credential =
      probed === undefined ? yield* host.credentials.get(JiraApi.KIND) : Option.some(probed);
    const origin = Option.isSome(credential)
      ? JiraApi.siteOrigin(credential.value.fields["site"] ?? "")
      : null;
    let api = JiraApi.make.pipe(
      Effect.provideService(
        IssueTrackerHost.IssueTrackerHost,
        IssueTrackerHost.IssueTrackerHost.of({
          credentials: { get: () => Effect.succeed(credential) },
        }),
      ),
    );
    // JiraApi refuses an environment login without a site itself.
    if (Option.isSome(credential) && credential.value.authentication === "environment" && origin) {
      api = api.pipe(
        Effect.provideService(JiraApi.JiraSessions, twg.forSite(origin, probed !== undefined)),
      );
    }
    return yield* JiraIssueTracker.make.pipe(
      Effect.provideServiceEffect(JiraApi.JiraApi, api),
      Effect.provide(context),
    );
  });

  const run = <A>(
    operation: (api: StandaloneIssueTrackerApi) => Effect.Effect<A, IssueTrackerError>,
  ) => tracker().pipe(Effect.flatMap(operation));
  const unsupported = (operation: string) =>
    Effect.fail(JiraApi.fail(operation, "failed", "Jira does not support this operation."));

  return {
    kind: JiraApi.KIND,
    capabilities: JiraIssueTracker.CAPABILITIES,
    standalone: JiraIssueTracker.DESCRIPTOR,
    // A connection check asks TWG afresh rather than reusing another operation's session.
    probeCredential: (credential) =>
      tracker(credential).pipe(Effect.flatMap((api) => api.probeCredential(credential))),
    getViewer: (input) => run((api) => api.getViewer(input)),
    listIssues: (input) => run((api) => api.listIssues(input)),
    getIssue: (input) => run((api) => api.getIssue(input)),
    getComments: (input) => run((api) => api.getComments(input)),
    create: (input) => run((api) => api.create?.(input) ?? unsupported("create")),
    comment: (input) => run((api) => api.comment?.(input) ?? unsupported("comment")),
    update: (input) => run((api) => api.update?.(input) ?? unsupported("update")),
    setState: (input) => run((api) => api.setState?.(input) ?? unsupported("setState")),
    listCandidates: (input) =>
      run((api) => api.listCandidates?.(input) ?? unsupported("listCandidates")),
  } satisfies StandaloneIssueTrackerApi;
});
