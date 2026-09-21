import type { GitRunStackedActionInput, GitRunStackedActionResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as OrchestratorV2 from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";

export const refreshPushedPullRequests = Effect.fn("refreshPushedPullRequests")(
  function* (
    input: Pick<GitRunStackedActionInput, "cwd" | "threadId" | "projectId">,
    result: Pick<GitRunStackedActionResult, "push">,
  ) {
    if (result.push.status !== "pushed") return;
    const pullRequests = yield* PullRequestService.PullRequestService;
    if (input.threadId !== undefined) {
      const engine = yield* OrchestratorV2.OrchestratorV2;
      const thread = yield* engine.getThreadShell(input.threadId);
      if (thread !== null) {
        yield* pullRequests.refreshAfterTurn(thread.projectId);
        return;
      }
    }
    if (input.projectId !== undefined) {
      yield* pullRequests.refreshAfterTurn(input.projectId);
      return;
    }
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const projects = yield* snapshots.getProjectShellsWithoutEnrichment();
    yield* Effect.forEach(
      projects.filter((project) => project.workspaceRoot === input.cwd),
      (project) => pullRequests.refreshAfterTurn(project.id),
      { discard: true },
    );
  },
  Effect.ignore({ log: true }),
);
