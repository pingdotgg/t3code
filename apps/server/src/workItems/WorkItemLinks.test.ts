import {
  ProjectId,
  PullRequestOperationError,
  type IssueDetail,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as IssueService from "../issue/IssueService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { WorkItemLinks, layer } from "./WorkItemLinks.ts";

const projectId = ProjectId.make("project-1");
const issueRef = { projectId, provider: "linear", repository: "team", number: 123 };
const pullRequestRef = { projectId, repository: "team/repo", number: 7 };
const issueUrl = "https://linear.app/team/issue/ABC-123/first-title?ref=home#activity";
const pullRequestUrl = "https://github.com/team/repo/pull/7";

describe("WorkItemLinks", () => {
  it.effect("saves one pair, lists from either side, and survives a Linear title slug change", () =>
    Effect.gen(function* () {
      const currentIssueUrl = yield* Ref.make(issueUrl);
      const reads = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const guards: unknown[] = [];
      const dependencies = Layer.mergeAll(
        SqlitePersistenceMemory,
        Layer.mock(IssueService.IssueService)({
          detail: (ref) =>
            Ref.update(reads, (values) => [...values, ref]).pipe(
              Effect.flatMap(() => Ref.get(currentIssueUrl)),
              Effect.map(
                (url) =>
                  ({
                    provider: "linear",
                    repository: "team",
                    number: 123,
                    title: "Issue",
                    url,
                  }) as IssueDetail,
              ),
            ),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          withRoutingCredential: (ref, operation) => {
            guards.push(ref);
            return ref.expectedAccountId === "denied"
              ? Effect.fail(
                  new PullRequestOperationError({
                    operation: "routing",
                    detail: "The account changed.",
                  }),
                )
              : operation;
          },
          detail: (ref) =>
            Ref.update(reads, (values) => [...values, ref]).pipe(
              Effect.as({
                provider: "github",
                repository: "team/repo",
                number: 7,
                title: "Pull request",
                url: pullRequestUrl,
              } as PullRequestDetail),
            ),
        }),
      );
      const result = yield* Effect.gen(function* () {
        const links = yield* WorkItemLinks;
        const refused = yield* links
          .link({
            issue: issueRef,
            pullRequest: { ...pullRequestRef, expectedAccountId: "denied" },
          })
          .pipe(Effect.flip);
        const afterRefusal = yield* links.list({ source: { provider: "linear", url: issueUrl } });
        const first = yield* links.link({ issue: issueRef, pullRequest: pullRequestRef });
        yield* Ref.set(currentIssueUrl, "https://linear.app/team/issue/ABC-123/new-title");
        const second = yield* links.link({ issue: issueRef, pullRequest: pullRequestRef });
        const fromIssue = yield* links.list({
          source: { provider: "linear", url: issueUrl },
        });
        const fromPullRequest = yield* links.list({
          source: { provider: "github", url: pullRequestUrl },
        });
        const otherHost = yield* links.list({
          source: { provider: "linear", url: "https://linear.example/team/issue/ABC-123" },
        });
        yield* links.unlink({ issue: first.issue, pullRequest: first.pullRequest });
        yield* links.unlink({ issue: first.issue, pullRequest: first.pullRequest });
        const afterUnlink = yield* links.list({ source: first.issue });
        return {
          refused,
          afterRefusal,
          first,
          second,
          fromIssue,
          fromPullRequest,
          otherHost,
          afterUnlink,
        };
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(dependencies))));
      expect(result.first.issue.url).toBe("https://linear.app/team/issue/ABC-123");
      expect(result.refused._tag).toBe("WorkItemLinkError");
      expect(result.afterRefusal.links).toEqual([]);
      expect(result.second).toEqual(result.first);
      expect(result.fromIssue).toEqual({ links: [result.first], truncated: false });
      expect(result.fromPullRequest).toEqual(result.fromIssue);
      expect(result.otherHost.links).toEqual([]);
      expect(result.afterUnlink.links).toEqual([]);
      expect(guards).toEqual([
        { ...pullRequestRef, expectedAccountId: "denied" },
        pullRequestRef,
        pullRequestRef,
      ]);
      expect((yield* Ref.get(reads)).filter((ref) => ref === pullRequestRef)).toHaveLength(2);
    }),
  );
});
