import * as Effect from "effect/Effect";
import type { IssueCapabilities, IssueViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import type { AzureDevOpsWorkItem } from "./azureDevOpsIssueJson.ts";
import {
  IssueProviderError,
  type IssueAdapter,
  type ProviderIssue,
  type ProviderIssueDetail,
} from "./IssueProvider.ts";

/**
 * Azure DevOps has work items rather than issues, and `az boards` reaches a narrow part of them:
 * a query, one item, and a field write. Everything past that — comments, labels, assignment,
 * text search — lives behind REST routes the CLI does not wrap, so it is declared missing rather
 * than half-implemented.
 */
const CAPABILITIES: IssueCapabilities = {
  // `az boards work-item update --discussion` posts one, but nothing in `az boards` reads the
  // discussion back — and a composer that writes into a conversation the reader cannot see is
  // worse than no composer.
  comment: false,
  actions: ["close", "reopen"],
  // A state is written like any other field, so closing carries no reason to record.
  closeReasons: [],
  // Filing a work item needs its type, and which types a project has is its own process
  // template's business — a guess would file the wrong kind of thing.
  create: false,
  // A work item's starting point is its process template's, which lives in the project's process
  // definition rather than in the repository, and `az boards` reads none of it.
  issueTemplates: false,
  edit: false,
  editComment: false,
  // Azure has tags rather than labels, on a different field with different semantics.
  labels: false,
  // One assignee, written as an identity `az boards` resolves but never lists.
  assignees: false,
  listLabelCandidates: false,
  listAssigneeCandidates: false,
  // `az boards query` filters by WIQL clauses, and by no free text.
  search: false,
  linkedPullRequests: false,
  timelineEvents: false,
};

/**
 * Everything this host offers, granted to whoever is signed in. Azure states no permission
 * anywhere `az boards` reaches: the answer lives in the security namespaces, behind identity
 * descriptors that would be several calls per work item to resolve.
 *
 * So the two actions stay live and a viewer who may not take one is told so by Azure, at the
 * moment they try — the safer half of an unknown, since hiding a control from somebody entitled
 * to it leaves them no way through and no reason given.
 */
export const AZURE_DEVOPS_ISSUE_VIEWER_PERMISSIONS: IssueViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment,
  edit: CAPABILITIES.edit,
  labels: CAPABILITIES.labels,
  assignees: CAPABILITIES.assignees,
  create: CAPABILITIES.create,
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: AzureDevOpsIssueCli.AzureDevOpsIssueCliError,
): IssueProviderError["reason"] {
  if (error._tag === "AzureDevOpsCliUnavailableError") return "missing-tool";
  if (error._tag === "AzureDevOpsCliAuthenticationError") return "unauthenticated";
  return "failed";
}

function toIssue(item: AzureDevOpsWorkItem): ProviderIssue {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    author: item.author,
    state: item.state,
    // Azure records which state a work item moved into, never why it was left.
    stateReason: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt,
    assignees: item.assignees,
    labels: [],
    milestone: null,
    commentCount: 0,
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

  const fail =
    (operation: string) =>
    (error: AzureDevOpsIssueCli.AzureDevOpsIssueCliError): IssueProviderError => {
      const { detail } = error;
      return new IssueProviderError({
        provider: "azure-devops",
        operation,
        reason: reasonFor(error),
        detail,
        cause: error,
      });
    };

  /** Declared unavailable in `CAPABILITIES`, so the service refuses these before reaching here. */
  const unsupported = (operation: string) =>
    Effect.fail(
      new IssueProviderError({
        provider: "azure-devops",
        operation,
        reason: "failed",
        detail: "Azure DevOps work items cannot be changed this way from the CLI.",
      }),
    );

  return {
    kind: "azure-devops",
    capabilities: CAPABILITIES,

    getViewer: (input) => cli.getViewer(input).pipe(Effect.mapError(fail("getViewer"))),

    // Refused rather than answered with everything: Azure records no mention of a person on a
    // work item, and nothing between here and the reader narrows a listing back down — so the
    // page a mention filter would produce is every work item in the project.
    listIssues: (input) =>
      input.involvement === "mentioned"
        ? Effect.fail(
            new IssueProviderError({
              provider: "azure-devops",
              operation: "listIssues",
              reason: "failed",
              detail: "Azure DevOps records no mention of a person on a work item.",
            }),
          )
        : cli
            .listWorkItems({
              cwd: input.cwd,
              state: input.state,
              involvement: input.involvement,
              limit: input.limit,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            })
            .pipe(
              Effect.mapError(fail("listIssues")),
              Effect.map((page) => ({
                items: page.items.map(toIssue),
                truncated: page.truncated,
                // The query orders by the same date the cursor carries, so a further slice means
                // exactly what it does on every other host here.
                continues: true,
              })),
            ),

    getIssue: (input) =>
      cli.getWorkItem({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getIssue")),
        Effect.map(
          (item): ProviderIssueDetail => ({
            ...toIssue(item),
            body: item.description,
            linkedPullRequests: [],
            viewerPermissions: AZURE_DEVOPS_ISSUE_VIEWER_PERMISSIONS,
          }),
        ),
      ),

    // Nothing in `az boards` reads a discussion back, so the conversation is empty rather than
    // partly read: a count nobody can open is worse than none.
    getIssueActivity: () =>
      Effect.succeed({ comments: [], commentCount: 0, commentsTruncated: false, events: [] }),

    // No request at all: Azure has nothing to say about the viewer that a work item read reaches.
    getViewerPermissions: () => Effect.succeed(AZURE_DEVOPS_ISSUE_VIEWER_PERMISSIONS),

    runAction: (input) =>
      cli
        .runWorkItemAction({ cwd: input.cwd, number: input.number, action: input.action })
        .pipe(Effect.mapError(fail("runAction"))),

    // Declared unsupported above, so the service refuses these before a provider is reached.
    // They exist because every provider answers the whole port.
    comment: () => unsupported("comment"),

    create: () => unsupported("create"),

    update: () => unsupported("update"),

    setLabels: () => unsupported("setLabels"),

    setAssignees: () => unsupported("setAssignees"),

    listLabelCandidates: () => unsupported("listLabelCandidates"),

    listAssigneeCandidates: () => unsupported("listAssigneeCandidates"),
  } satisfies IssueAdapter;
});
