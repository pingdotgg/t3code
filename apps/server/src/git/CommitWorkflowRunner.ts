import {
  GitManagerError,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type GitStartCommitWorkflowInput,
  type GitStartCommitWorkflowResult,
  type ModelSelection,
  type ProjectId,
  type SourceControlWritingStyleSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { buildCommitWorkflowPrompt } from "./commitWorkflowPrompt.ts";

export interface CommitWorkflowRunInput {
  readonly request: GitStartCommitWorkflowInput;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly style: SourceControlWritingStyleSettings;
}

const makeAppThread = Schema.decodeSync(OrchestrationV2AppThread);
const isGitManagerError = Schema.is(GitManagerError);

export class CommitWorkflowRunner extends Context.Service<
  CommitWorkflowRunner,
  {
    readonly run: (
      input: CommitWorkflowRunInput,
    ) => Effect.Effect<GitStartCommitWorkflowResult, GitManagerError>;
  }
>()("t3/git/CommitWorkflowRunner") {}

/** @public */
export const make = Effect.gen(function* () {
  const adapters = yield* ProviderAdapters.ProviderAdapterRegistryV2;
  const run = Effect.fn("CommitWorkflowRunner.run")(function* (input: CommitWorkflowRunInput) {
    const { request, modelSelection } = input;
    const fail = (detail: string) =>
      new GitManagerError({ operation: "splitCommits", cwd: request.cwd, detail });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* adapters.get(modelSelection.instanceId);
        // Adapter identities are private to this scoped operation. No app thread,
        // run, messages, or provider events are persisted in the orchestrator.
        const id = `git-commit-action:${request.commandId}`;
        const threadId = ThreadId.make(id);
        const runtimePolicy = {
          cwd: request.cwd,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
        };
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(id),
          modelSelection,
          runtimePolicy,
        });
        const subscription = session.subscribeEvents ? yield* session.subscribeEvents : null;
        if (subscription) yield* Effect.addFinalizer(() => subscription.close);
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const summary = yield* Ref.make("");
        const done = yield* Deferred.make<void, GitManagerError>();
        yield* (subscription?.events ?? session.events).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "message.updated" && event.message.role === "assistant") {
                yield* Ref.set(summary, event.message.text.slice(-20_000));
              }
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
              ) {
                yield* Deferred.fail(
                  done,
                  fail(
                    "The source-control provider requested interactive input. The quick action was stopped; inspect its backup refs before retrying.",
                  ),
                );
              }
              if (event.type === "turn.terminal" && event.providerThreadId === providerThread.id) {
                if (event.status === "completed") yield* Deferred.succeed(done, undefined);
                else
                  yield* Deferred.fail(
                    done,
                    fail(
                      event.status === "failed"
                        ? event.failure.message
                        : "Commit splitting was interrupted.",
                    ),
                  );
              }
            }),
          ),
          Effect.andThen(
            Deferred.fail(done, fail("The provider stopped before completing commit splitting.")),
          ),
          Effect.catch((cause) => Deferred.fail(done, fail(cause.message))),
          Effect.forkScoped,
        );
        const now = yield* DateTime.now;
        const appThread = makeAppThread({
          id: threadId,
          projectId: input.projectId,
          title: "Split into logical commits",
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: request.expectedBranch,
          worktreePath: request.cwd,
          activeProviderThreadId: null,
          lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledAt: null,
          deletedAt: null,
          createdBy: "user",
          creationSource: "server",
        });
        yield* session.startTurn({
          appThread,
          threadId,
          runId: RunId.make(id),
          runOrdinal: 1,
          nativeThreadHasTurns: false,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make(id),
          rootNodeId: NodeId.make(id),
          providerThread,
          modelSelection,
          runtimePolicy,
          message: {
            messageId: MessageId.make(id),
            text: buildCommitWorkflowPrompt(request, input.style),
            attachments: [],
            createdBy: "user",
            creationSource: "server",
          },
        });
        yield* Deferred.await(done);
        return { summary: (yield* Ref.get(summary)) || "Commit splitting completed." };
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isGitManagerError(cause)
          ? cause
          : new GitManagerError({
              operation: "splitCommits",
              cwd: request.cwd,
              detail: "The source-control provider could not complete commit splitting.",
              cause,
            }),
      ),
    );
  });
  return CommitWorkflowRunner.of({ run });
});

export const layer = Layer.effect(CommitWorkflowRunner, make);
