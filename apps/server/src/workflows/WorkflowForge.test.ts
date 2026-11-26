import { assert, it } from "@effect/vitest";
import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../issue/IssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { StepReferences } from "./runReferences.ts";
import * as WorkflowForge from "./WorkflowForge.ts";
import type { ReferenceInput } from "./WorkflowStore.ts";

const projectId = ProjectId.make("project-1");
const forge = WorkflowForge.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(IssueService.IssueService)({ comment: () => Effect.void }),
      Layer.mock(PullRequestService.PullRequestService)({
        runAction: () => Effect.void as never,
        detail: () =>
          Effect.succeed({
            projectId,
            repository: "Me/App",
            number: 7,
            title: "Minutes wrap at the hour",
            url: "https://github.com/Me/App/pull/7",
            state: "merged",
          } as never),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getByWorkspaceRoot: () => Effect.succeedSome({ id: projectId } as never),
      }),
    ),
  ),
);

it.effect("what a step does through the forge is kept against it, one key per thing", () =>
  Effect.gen(function* () {
    const { issues, pullRequests } = yield* WorkflowForge.WorkflowForge;
    const noted: Array<ReferenceInput> = [];
    const inStep = Context.make(StepReferences, {
      note: (reference) => Effect.sync(() => void noted.push(reference)),
    });
    const issue = {
      projectId,
      tracker: IssueTrackerKind.make("github"),
      host: "github.com",
      scope: "me/app",
      key: "3",
    };
    yield* Effect.provideContext(
      Effect.all([
        // By its address, then as a listing names it: the same pull request either way.
        pullRequests.act(
          { project: "/home/me/app", url: "https://github.com/Me/App/pull/7" },
          "merge",
        ),
        pullRequests.read({ projectId, host: "github.com", repository: "me/app", number: 7 }),
        issues.comment(issue, "Looking at it."),
      ]),
      inStep,
    );
    // Outside a step nothing is kept.
    yield* issues.comment(issue, "Again.");
    assert.deepStrictEqual(
      noted.map(({ kind, key, title, state }) => ({ kind, key, title, state })),
      [
        { kind: "pullRequest", key: noted[1]!.key, title: "", state: undefined },
        {
          kind: "pullRequest",
          key: '["github.com","me/app",7]',
          title: "Minutes wrap at the hour",
          state: "merged",
        },
        { kind: "issue", key: '["github","github.com","me/app","3"]', title: "", state: undefined },
      ],
    );
    assert.deepStrictEqual(noted[1]!.address, {
      projectId,
      host: "github.com",
      repository: "me/app",
      number: 7,
    });
  }).pipe(Effect.provide(forge)),
);

it.effect("a step can name its project by a Windows folder", () =>
  Effect.gen(function* () {
    const { pullRequests } = yield* WorkflowForge.WorkflowForge;
    const noted: Array<ReferenceInput> = [];
    const inStep = Context.make(StepReferences, {
      note: (reference) => Effect.sync(() => void noted.push(reference)),
    });
    for (const project of ["C:\\Users\\me\\app", "C:/Users/me/app"]) {
      yield* Effect.provideContext(
        pullRequests.act({ project, url: "https://github.com/Me/App/pull/7" }, "merge"),
        inStep,
      );
    }
    const address = { projectId, host: "github.com", repository: "me/app", number: 7 };
    assert.deepStrictEqual(
      noted.map((reference) => reference.address),
      [address, address],
    );
  }).pipe(Effect.provide(forge)),
);

it("a step's pull requests are the ones its thread was linked to while it ran", () => {
  const link = (number: number, linkedAt: string, source = "agent") => ({
    host: "github.com",
    repository: "me/app",
    number,
    url: `https://github.com/me/app/pull/${number}`,
    source,
    linkedAt,
    snapshot: null,
  });
  const references = WorkflowForge.linkedPullRequestReferences(
    {
      projectId,
      pullRequests: [
        link(1, "2026-01-01T00:00:00.000Z"),
        link(2, "2026-01-01T00:10:00.000Z"),
        link(3, "2026-01-01T00:10:00.000Z", "stack-dismissed"),
      ] as never,
    },
    Date.parse("2026-01-01T00:05:00.000Z"),
  );
  assert.deepStrictEqual(
    references.map((reference) => [reference.key, reference.url]),
    [['["github.com","me/app",2]', "https://github.com/me/app/pull/2"]],
  );
});
