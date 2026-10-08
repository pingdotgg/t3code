import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  IssueOperationError,
  PullRequestOperationError,
  TextGenerationError,
  type IssueDetail,
  type IssueListResult,
  type PullRequestDetail,
  type PullRequestListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkItemMatches from "./WorkItemMatches.ts";

const projectId = ProjectId.make("project");
const item = (number: number) => ({
  projectId,
  provider: "github",
  repository: "acme/app",
  number,
  title: "Session refresh",
  url: `https://github.com/acme/app/issues/${number}`,
});
const detail = (number: number) => ({
  ...item(number),
  workspaceRoot: "/workspace",
  body: "Refresh expired sessions",
  capabilities: { referenceStyle: "hash" },
  linkedPullRequests: [item(2)],
  linkedIssues: [item(2)],
});
const dependencies = Layer.mergeAll(
  Layer.mock(IssueService.IssueService)({
    detail: ({ number }) => Effect.succeed(detail(number) as unknown as IssueDetail),
    list: () =>
      Effect.succeed({ entries: [item(1), item(2), item(3)] } as unknown as IssueListResult),
  }),
  Layer.mock(PullRequestService.PullRequestService)({
    detail: ({ number }) => Effect.succeed(detail(number) as unknown as PullRequestDetail),
    list: () =>
      Effect.succeed({ entries: [item(1), item(2), item(3)] } as unknown as PullRequestListResult),
  }),
  ServerSettings.layerTest(),
);

describe("WorkItemMatches", () => {
  it.effect.each([
    { kind: "issue", relationship: "related" },
    { kind: "issue", relationship: "duplicate" },
    { kind: "pull-request", relationship: "related" },
    { kind: "pull-request", relationship: "duplicate" },
  ] as const)(
    "matches $kind $relationship candidates through the service",
    ({ kind, relationship }) =>
      Effect.gen(function* () {
        const textGeneration = Layer.mock(TextGeneration.TextGeneration)({
          findWorkItemMatches: (input) => {
            expect(input.cwd).toBe("/workspace");
            expect(input.relationship).toBe(relationship);
            expect(input.source.kind).toBe(kind);
            expect(input.candidates.map((candidate) => candidate.number)).toEqual(
              relationship === "related" ? [1, 3] : [2, 3],
            );
            expect(
              input.candidates.every(
                (candidate) =>
                  candidate.kind ===
                  (relationship === "duplicate"
                    ? kind
                    : kind === "issue"
                      ? "pull-request"
                      : "issue"),
              ),
            ).toBe(true);
            return Effect.succeed({
              matches: [
                { candidate: 2, confidence: "high", reason: "Same session fix" },
                { candidate: 99, confidence: "high", reason: "Invalid" },
              ],
            });
          },
        });
        const service = yield* WorkItemMatches.WorkItemMatches.pipe(
          Effect.provide(
            WorkItemMatches.layer.pipe(Layer.provide(dependencies), Layer.provide(textGeneration)),
          ),
        );
        const result = yield* service.find({
          projectId,
          relationship,
          source: { ...item(1), kind },
        });
        expect(result.matches.map((match) => match.number)).toEqual([3]);
      }),
  );

  it.effect("skips generation when no candidates remain", () =>
    Effect.gen(function* () {
      const service = yield* WorkItemMatches.WorkItemMatches;
      expect(
        yield* service.find({
          projectId,
          relationship: "duplicate",
          source: { ...item(1), kind: "issue" },
        }),
      ).toEqual({ matches: [] });
    }).pipe(
      Effect.provide(
        WorkItemMatches.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              dependencies,
              Layer.mock(IssueService.IssueService)({
                detail: () => Effect.succeed(detail(1) as unknown as IssueDetail),
                list: () => Effect.succeed({ entries: [item(1)] } as unknown as IssueListResult),
              }),
              Layer.mock(TextGeneration.TextGeneration)({
                findWorkItemMatches: () => Effect.die("Must not generate"),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect.each(["github", "gitlab"])(
    "excludes a Linear issue's known $0 pull request before reading candidates or generating matches",
    (provider) =>
      Effect.gen(function* () {
        const pullRequest = {
          ...item(2),
          provider,
          url:
            provider === "github"
              ? "https://github.com/acme/app/pull/2"
              : "https://gitlab.com/acme/app/-/merge_requests/2",
        };
        const service = yield* WorkItemMatches.WorkItemMatches.pipe(
          Effect.provide(
            WorkItemMatches.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  dependencies,
                  Layer.mock(IssueService.IssueService)({
                    detail: () =>
                      Effect.succeed({
                        ...detail(1),
                        provider: "linear",
                        linkedPullRequests: [
                          { ...pullRequest, url: `${pullRequest.url}#discussion` },
                        ],
                      } as unknown as IssueDetail),
                  }),
                  Layer.mock(PullRequestService.PullRequestService)({
                    list: () =>
                      Effect.succeed({
                        entries: [pullRequest],
                      } as unknown as PullRequestListResult),
                    detail: () => Effect.die("Must not read a known pull request"),
                  }),
                  Layer.mock(TextGeneration.TextGeneration)({
                    findWorkItemMatches: () =>
                      Effect.die("Must not generate for a known pull request"),
                  }),
                ),
              ),
            ),
          ),
        );
        expect(
          yield* service.find({
            projectId,
            relationship: "related",
            source: { kind: "issue", provider: "linear", repository: "ENG", number: 1 },
          }),
        ).toEqual({ matches: [] });
      }),
  );

  it.effect(
    "keeps pull requests with the same repository and number on other hosts or providers",
    () =>
      Effect.gen(function* () {
        const known = { ...item(2), url: "https://github.com/acme/app/pull/2" };
        const candidates = [
          {
            ...known,
            projectId: ProjectId.make("enterprise-project"),
            url: "https://github.example.com/acme/app/pull/2",
          },
          {
            ...known,
            projectId: ProjectId.make("gitlab-project"),
            provider: "gitlab",
            url: "https://gitlab.com/acme/app/-/merge_requests/2",
          },
        ];
        const service = yield* WorkItemMatches.WorkItemMatches.pipe(
          Effect.provide(
            WorkItemMatches.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  dependencies,
                  Layer.mock(IssueService.IssueService)({
                    detail: () =>
                      Effect.succeed({
                        ...detail(1),
                        linkedPullRequests: [known],
                      } as unknown as IssueDetail),
                  }),
                  Layer.mock(PullRequestService.PullRequestService)({
                    list: () =>
                      Effect.succeed({ entries: candidates } as unknown as PullRequestListResult),
                    detail: ({ projectId: candidateProjectId }) =>
                      Effect.succeed({
                        ...detail(2),
                        ...candidates.find(
                          (candidate) => candidate.projectId === candidateProjectId,
                        ),
                      } as unknown as PullRequestDetail),
                  }),
                  Layer.mock(TextGeneration.TextGeneration)({
                    findWorkItemMatches: (input) => {
                      expect(input.candidates.map((candidate) => candidate.url)).toEqual(
                        candidates.map((candidate) => candidate.url),
                      );
                      return Effect.succeed({ matches: [] });
                    },
                  }),
                ),
              ),
            ),
          ),
        );
        yield* service.find({
          projectId,
          relationship: "related",
          source: { ...item(1), kind: "issue" },
        });
      }),
  );

  it.effect.each(["read-source", "list-candidates", "read-candidate", "generate"] as const)(
    "preserves the underlying $0 failure",
    (stage) =>
      Effect.gen(function* () {
        const issueCause = new IssueOperationError({ operation: "detail", detail: "Failed" });
        const pullRequestCause = new PullRequestOperationError({
          operation: "detail",
          detail: "Failed",
        });
        const generationCause = new TextGenerationError({
          operation: "findWorkItemMatches",
          detail: "Failed",
        });
        const service = yield* WorkItemMatches.WorkItemMatches.pipe(
          Effect.provide(
            WorkItemMatches.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  dependencies,
                  Layer.mock(IssueService.IssueService)({
                    detail: () =>
                      stage === "read-source"
                        ? Effect.fail(issueCause)
                        : Effect.succeed(detail(1) as unknown as IssueDetail),
                  }),
                  Layer.mock(PullRequestService.PullRequestService)({
                    detail: () =>
                      stage === "read-candidate"
                        ? Effect.fail(pullRequestCause)
                        : Effect.succeed(detail(3) as unknown as PullRequestDetail),
                    list: () =>
                      stage === "list-candidates"
                        ? Effect.fail(pullRequestCause)
                        : Effect.succeed({
                            entries: [item(3)],
                          } as unknown as PullRequestListResult),
                  }),
                  Layer.mock(TextGeneration.TextGeneration)({
                    findWorkItemMatches: () => Effect.fail(generationCause),
                  }),
                ),
              ),
            ),
          ),
        );
        const error = yield* service
          .find({ projectId, relationship: "related", source: { ...item(1), kind: "issue" } })
          .pipe(Effect.flip);
        expect(error.operation).toBe(stage);
        expect(error.cause).toBe(
          stage === "generate"
            ? generationCause
            : stage === "read-source"
              ? issueCause
              : pullRequestCause,
        );
      }),
  );
});
