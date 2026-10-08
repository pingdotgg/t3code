import {
  WorkItemMatchError,
  normalizeWorkItemLinkKey,
  type WorkItemMatchInput,
  type WorkItemMatchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { resolveWorkItemMatches, shortlistWorkItemCandidates } from "./WorkItemMatching.ts";

export class WorkItemMatches extends Context.Service<
  WorkItemMatches,
  {
    readonly find: (
      input: WorkItemMatchInput,
    ) => Effect.Effect<WorkItemMatchResult, WorkItemMatchError>;
  }
>()("t3/workItems/WorkItemMatches") {}

const make = Effect.gen(function* () {
  const issues = yield* IssueService.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  return WorkItemMatches.of({
    find: Effect.fn("WorkItemMatches.find")(function* (input: WorkItemMatchInput) {
      const reference = {
        projectId: input.projectId,
        ...(input.source.provider === undefined ? {} : { provider: input.source.provider }),
        repository: input.source.repository,
        number: input.source.number,
      };
      const sourceRead =
        input.source.kind === "issue"
          ? issues.detail(reference).pipe(
              Effect.map((detail) => ({
                detail,
                referenceStyle: detail.capabilities.referenceStyle,
                known:
                  input.relationship === "related"
                    ? detail.linkedPullRequests.map(
                        (link) =>
                          normalizeWorkItemLinkKey({
                            provider: detail.provider,
                            url: link.url,
                          }).url,
                      )
                    : [],
              })),
              Effect.mapError(
                (cause) =>
                  new WorkItemMatchError({
                    operation: "read-source",
                    source: input.source,
                    detail: "Could not read the source work item.",
                    cause,
                  }),
              ),
            )
          : pullRequests.detail(reference).pipe(
              Effect.map((detail) => ({
                detail,
                referenceStyle: "hash" as const,
                known:
                  input.relationship === "related"
                    ? (detail.linkedIssues ?? []).map(
                        (link) =>
                          normalizeWorkItemLinkKey({
                            provider: detail.provider,
                            url: link.url,
                          }).url,
                      )
                    : [],
              })),
              Effect.mapError(
                (cause) =>
                  new WorkItemMatchError({
                    operation: "read-source",
                    source: input.source,
                    detail: "Could not read the source work item.",
                    cause,
                  }),
              ),
            );
      const { detail: sourceDetail, referenceStyle, known } = yield* sourceRead;
      const source = {
        kind: input.source.kind,
        referenceStyle,
        provider: sourceDetail.provider,
        repository: sourceDetail.repository,
        number: sourceDetail.number,
        title: sourceDetail.title,
        url: sourceDetail.url,
        body: sourceDetail.body,
      };
      const candidateKind =
        input.relationship === "duplicate"
          ? input.source.kind
          : input.source.kind === "issue"
            ? "pull-request"
            : "issue";
      const listed =
        candidateKind === "issue"
          ? yield* issues
              .list({
                state: input.relationship === "duplicate" ? "all" : "open",
                projectId: input.projectId,
                limit: 50,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkItemMatchError({
                      operation: "list-candidates",
                      source: input.source,
                      detail: "Could not list candidate work items.",
                      cause,
                    }),
                ),
              )
          : yield* pullRequests
              .list({
                state: input.relationship === "duplicate" ? "all" : "open",
                projectId: input.projectId,
                limit: 50,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkItemMatchError({
                      operation: "list-candidates",
                      source: input.source,
                      detail: "Could not list candidate work items.",
                      cause,
                    }),
                ),
              );
      const knownItems = new Set(known);
      const candidates = shortlistWorkItemCandidates(
        source,
        listed.entries
          .slice(0, 50)
          .filter((entry) => !knownItems.has(normalizeWorkItemLinkKey(entry).url))
          .map((entry) => ({ ...entry, kind: candidateKind })),
      );
      const candidateDetails = yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            const candidateReference = {
              projectId: candidate.projectId,
              provider: candidate.provider,
              repository: candidate.repository,
              number: candidate.number,
            };
            if (candidateKind === "issue") {
              const detail = yield* issues.detail(candidateReference);
              return {
                kind: "issue" as const,
                referenceStyle: detail.capabilities.referenceStyle,
                closesViaPullRequest: detail.capabilities.closesViaPullRequest,
                provider: detail.provider,
                repository: detail.repository,
                number: detail.number,
                title: detail.title,
                url: detail.url,
                body: detail.body,
              };
            }
            const detail = yield* pullRequests.detail(candidateReference);
            return {
              kind: "pull-request" as const,
              provider: detail.provider,
              repository: detail.repository,
              number: detail.number,
              title: detail.title,
              url: detail.url,
              body: detail.body,
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new WorkItemMatchError({
                  operation: "read-candidate",
                  source: {
                    kind: candidateKind,
                    provider: candidate.provider,
                    repository: candidate.repository,
                    number: candidate.number,
                  },
                  detail: "Could not read a candidate work item.",
                  cause,
                }),
            ),
          ),
        { concurrency: 4 },
      );
      if (candidateDetails.length === 0) return { matches: [] };
      const generated = yield* Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        return yield* textGeneration.findWorkItemMatches({
          cwd: sourceDetail.workspaceRoot,
          relationship: input.relationship,
          source,
          candidates: candidateDetails,
          modelSelection: settings.textGenerationModelSelection,
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkItemMatchError({
              operation: "generate",
              source: input.source,
              detail: "Could not generate work item matches.",
              cause,
            }),
        ),
      );
      return { matches: resolveWorkItemMatches(candidateDetails, generated.matches) };
    }),
  });
});

export const layer = Layer.effect(WorkItemMatches, make);
