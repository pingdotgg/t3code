import {
  CommandId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PullRequestUnavailableError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "./PullRequestService.ts";
import {
  resolveTarget,
  type PullRequestTarget,
  type PullRequestTargetError,
  type ResolvedTarget,
} from "./pullRequestTarget.ts";
import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change whether the pull request is watched.";
  }
}

export class PullRequestNotOpenError extends Schema.TaggedError<PullRequestNotOpenError>()(
  "PullRequestNotOpenError",
  { state: Schema.String },
) {
  override get message(): string {
    return `The pull request is ${this.state}, so there is nothing to watch.`;
  }
}

export class PullRequestWatchFromSubagentError extends Schema.TaggedError<PullRequestWatchFromSubagentError>()(
  "PullRequestWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";
  }
}

export class PullRequestWatchThreadNotFoundError extends Schema.TaggedError<PullRequestWatchThreadNotFoundError>()(
  "PullRequestWatchThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PullRequestWatchService extends Context.Service<
  PullRequestWatchService,
  {
    readonly setWatching: (input: {
      readonly threadId: ThreadId;
      readonly target: PullRequestTarget;
      readonly watching: boolean;
    }) => Effect.Effect<
      ResolvedTarget & { readonly watching: boolean; readonly wasWatching: boolean },
      | PullRequestWatchFailedError
      | PullRequestNotOpenError
      | PullRequestWatchFromSubagentError
      | PullRequestWatchThreadNotFoundError
      | PullRequestTargetError
      | PullRequestUnavailableError
    >;
  }
>()("t3/pullRequest/PullRequestWatchService") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;

  const requireThread = Effect.fn("PullRequestWatchService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new PullRequestWatchThreadNotFoundError({ threadId });
    }
    return thread;
  });

  // Keep the registration span stable across the service extraction.
  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (input: {
    readonly threadId: ThreadId;
    readonly target: PullRequestTarget;
    readonly watching: boolean;
  }) {
    const { watching } = input;
    const thread = yield* requireThread(input.threadId);
    const project = yield* projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })),
    );
    const target = yield* resolveTarget(input.target, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    if (watching && thread.lineage.relationshipToParent === "subagent") {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    if (watching && before?.snapshot?.state === "merged") {
      return yield* new PullRequestNotOpenError({ state: "merged" });
    }
    if (watching && before?.watch === undefined) {
      yield* pullRequests
        .summary(
          {
            projectId: thread.projectId,
            host: target.host,
            repository: target.repository,
            number: target.number,
            allowStale: false,
          },
          { recoverTransientFailure: false, bypassCache: true },
        )
        .pipe(
          Effect.flatMap((summary) =>
            summary.state === "merged"
              ? Effect.fail(new PullRequestNotOpenError({ state: "merged" }))
              : Effect.void,
          ),
          Effect.catchTags({
            // Host and transport errors can recover while the watch is active.
            PullRequestOperationError: () => Effect.void,
          }),
        );
    }
    const uuid = yield* random.uuidV4().pipe(Effect.orDie);
    yield* engine
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`server:mcp-pr-watch:${thread.id}:${uuid}`),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(new PullRequestWatchFailedError({ cause })),
        ),
      );
    const after = yield* requireThread(thread.id);
    return {
      ...target,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching: before?.watch !== undefined,
    };
  });

  return PullRequestWatchService.of({ setWatching });
});

export const layer = Layer.effect(PullRequestWatchService, make);
