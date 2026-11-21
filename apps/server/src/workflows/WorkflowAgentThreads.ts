// Agent steps as threads: a step's turn is an ordinary thread turn that was asked for a result.
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Digest from "effect/crypto/Digest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkflowAgentLinks from "./WorkflowAgentLinks.ts";
import {
  isProjectPath,
  launchOnContinue,
  WorkflowAgentError,
  WorkflowAgents,
} from "./WorkflowAgents.ts";
import { noteReference } from "./runReferences.ts";
import { type IssueAddress, linkedPullRequestReferences, WorkflowForge } from "./WorkflowForge.ts";

// A turn can run for hours. Each look is bounded so a wait that lost its event is asked again.
const WAIT_SLICE = Duration.minutes(10);

const failed = (reason: string) => (cause: unknown) =>
  new WorkflowAgentError({
    reason: `${reason}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const digest = yield* Digest.Digest;
  const linked = yield* WorkflowAgentLinks.make;
  const forge = yield* WorkflowForge;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  // A tracker that is down must not cost the step its agent.
  const showIssue = (issue: IssueAddress | undefined, threadId: string) =>
    issue === undefined
      ? Effect.void
      : forge.issues.read(issue).pipe(
          Effect.flatMap((detail) =>
            threadIssues.link({
              threadId: ThreadId.make(threadId),
              ref: {
                projectId: detail.projectId,
                tracker: detail.tracker,
                host: detail.host,
                scope: detail.scope,
                key: detail.key,
              },
              url: detail.url,
              displayKey: detail.displayKey,
              title: detail.title,
              source: "agent",
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Could not link a workflow agent's thread to its issue", {
              threadId,
              reason: error.message,
            }),
          ),
        );
  // What the agent opened or linked while it worked is part of what its step touched.
  const noteLinked = (threadId: ThreadId, sinceMillis: number | undefined) =>
    threads.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.void
          : Effect.forEach(linkedPullRequestReferences(shell, sinceMillis), noteReference, {
              discard: true,
            }),
      ),
      Effect.ignore,
    );
  const here = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  /** The linked environment a step names, or nothing when it names this one. */
  const elsewhere = (environment: string | undefined) =>
    environment === here ? undefined : environment;

  // Thread, message and command ids all derive from the step's key, so a start that is asked for
  // again after a crash finds the turn it already started.
  const idOf = Effect.fn("WorkflowAgentThreads.idOf")(function* (key: string) {
    const hash = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(key))
      .pipe(Effect.mapError(failed("Could not derive the turn's id")));
    return `workflow:${Hex.encode(hash)}`;
  });

  const projectDefaults = Effect.fn("WorkflowAgentThreads.projectDefaults")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(failed("Could not read the project")));
    if (Option.isNone(project)) {
      return yield* new WorkflowAgentError({ reason: `Project ${projectId} was not found.` });
    }
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(failed("Could not read settings")),
    );
    return resolveProjectSettings(current, projectId, project.value).settings;
  });

  const projectIdOf = Effect.fn("WorkflowAgentThreads.projectIdOf")(function* (project: string) {
    if (!isProjectPath(project)) return ProjectId.make(project);
    const found = yield* projects
      .getByWorkspaceRoot(project)
      .pipe(Effect.mapError(failed("Could not read the project")));
    if (Option.isNone(found)) {
      return yield* new WorkflowAgentError({
        reason: `No project is registered at ${project}.`,
      });
    }
    return found.value.id;
  });

  return WorkflowAgents.of({
    start: Effect.fn("WorkflowAgentThreads.start")(function* (input) {
      const id = yield* idOf(input.key);
      const environment = elsewhere(input.environment);
      if (environment !== undefined) return yield* linked.start(input, environment, id, here);
      const commandId = CommandId.make(id);
      const messageId = MessageId.make(id);
      const outputSchema =
        input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema };

      if (input.thread !== undefined) {
        if (input.launch !== undefined) return yield* launchOnContinue;
        const threadId = ThreadId.make(input.thread);
        const shell = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(failed("Could not read the thread to continue")));
        if (shell === null || shell.deletedAt !== null) {
          return yield* new WorkflowAgentError({
            reason: `Thread ${input.thread} no longer exists, so it cannot be continued.`,
          });
        }
        const sent = yield* threads
          .sendToThread({
            projectId: shell.projectId,
            commandId,
            threadId,
            messageId,
            text: input.prompt,
            attachments: [],
            mode: "queue",
            ...outputSchema,
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.mapError(failed("Could not send to the thread")));
        yield* showIssue(input.issue, threadId);
        return { threadId, turnId: sent.run.id };
      }

      if (input.project === undefined) {
        return yield* new WorkflowAgentError({
          reason: "An agent step needs a `project` to start in, or a `thread` to continue.",
        });
      }
      const projectId = yield* projectIdOf(input.project);
      const defaults = yield* projectDefaults(projectId);
      const modelSelection: ModelSelection | undefined =
        input.model === undefined
          ? (resolveNewThreadModelSelection({
              defaultSelection: defaults.defaultModelSelection,
              fallbackSelection: defaults.fallbackModelSelection,
              providers: yield* providers.getProviders,
              settings: defaults,
              projectId,
              now: DateTime.toEpochMillis(yield* DateTime.now),
            }).selection ?? undefined)
          : {
              instanceId: ProviderInstanceId.make(input.model.instanceId),
              model: input.model.model,
              ...(input.model.options === undefined ? {} : { options: input.model.options }),
            };
      if (modelSelection === undefined) {
        return yield* new WorkflowAgentError({
          reason: `Project ${input.project} has no default model. Give the agent step a \`model\`.`,
        });
      }
      const launched = yield* launches
        .launch({
          commandId,
          threadId: ThreadId.make(id),
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: input.launch?.runtimeMode ?? defaults.defaultRuntimeMode,
          interactionMode: input.launch?.interactionMode ?? "default",
          workspaceStrategy: input.launch?.workspace ?? { type: "root" },
          initialMessage: { messageId, text: input.prompt, attachments: [], ...outputSchema },
          createdBy: "system",
          creationSource: "server",
          workflowRun: { environmentId: here, ...input.origin },
        })
        .pipe(Effect.mapError(failed("Could not start the thread")));
      const run = launched.projection.runs.find(
        (candidate) => candidate.userMessageId === messageId,
      );
      if (run === undefined) {
        return yield* new WorkflowAgentError({
          reason: `Thread ${launched.threadId} started without a turn for its first message.`,
        });
      }
      yield* showIssue(input.issue, launched.threadId);
      return { threadId: launched.threadId, turnId: run.id };
    }),
    result: Effect.fn("WorkflowAgentThreads.result")(function* (turn, options) {
      const environment = elsewhere(turn.environment);
      if (environment !== undefined) return yield* linked.result(turn, environment, options);
      const threadId = ThreadId.make(turn.threadId);
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(failed("Could not read the thread")));
      if (shell === null) {
        return yield* new WorkflowAgentError({
          reason: `Thread ${turn.threadId} no longer exists.`,
        });
      }
      // The newest turn already seen to end without the result, so quiet is not restarted by it.
      let quietSince = -1;
      while (true) {
        const waited = yield* threads
          .waitForThread({
            projectId: shell.projectId,
            threadId,
            runId: turn.turnId as RunId,
            timeoutMs: Duration.toMillis(WAIT_SLICE),
          })
          .pipe(Effect.mapError(failed("Could not wait for the turn")));
        let run = waited.run;
        if (waited.timedOut || run === null) continue;
        // The agent may have ended its turn to wait for something that will wake it.
        const quiet = options?.quiet;
        const owes = (candidate: NonNullable<typeof waited.run>) =>
          candidate.status === "completed" &&
          candidate.outputSchema !== undefined &&
          candidate.output === undefined;
        while (owes(run)) {
          if (quiet === undefined) break;
          const owed: ThreadManagement.ThreadManagementWaitResult = yield* threads
            .waitForThread({
              projectId: shell.projectId,
              threadId,
              runId: run.id,
              untilOutput: true,
              timeoutMs: Duration.toMillis(quiet),
            })
            .pipe(Effect.mapError(failed("Could not wait for the turn's result")));
          if (owed.run === null) break;
          run = owed.run;
          if (!owed.timedOut) continue;
          // Quiet is counted from the thread's last turn, so one under way is waited out first.
          const latest = yield* threads
            .waitForThread({
              projectId: shell.projectId,
              threadId,
              timeoutMs: Duration.toMillis(WAIT_SLICE),
            })
            .pipe(Effect.mapError(failed("Could not wait for the thread")));
          if (latest.run === null || latest.run.id === run.id) break;
          if (!latest.timedOut && latest.run.ordinal <= quietSince) break;
          quietSince = latest.timedOut ? quietSince : latest.run.ordinal;
        }
        yield* noteLinked(threadId, turn.startedAt);
        if (run.status !== "completed") {
          // Interrupted or cancelled is someone stopping it; the rest is the turn dying.
          const ending = run.status === "failed" ? ("failed" as const) : ("stopped" as const);
          return { ending, detail: run.status, reply: "" };
        }
        const records = yield* threads
          .getThreadRecords(threadId, ["messages", "turnItems", "providerTurns"])
          .pipe(Effect.mapError(failed("Could not read the turn's reply")));
        return {
          ending: "completed" as const,
          detail: "",
          reply: subagentResultForRun(records, run).text,
          ...(run.output === undefined ? {} : { output: run.output.value }),
        };
      }
    }),
    interrupt: Effect.fn("WorkflowAgentThreads.interrupt")(function* (target) {
      const environment = elsewhere(target.environment);
      if (environment !== undefined)
        return yield* linked.interrupt(target.threadId, environment, target.turnId);
      const thread = target.threadId;
      const threadId = ThreadId.make(thread);
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(failed("Could not read the thread")));
      if (shell === null) return "ended" as const;
      const stopped = yield* threads
        .interruptThread({
          projectId: shell.projectId,
          threadId,
          commandId: CommandId.make(
            `workflow:interrupt:${thread}:${target.turnId ?? ""}:${yield* Clock.currentTimeMillis}`,
          ),
          reason: "Its workflow run was cancelled",
          ...(target.turnId === undefined ? {} : { runId: target.turnId as RunId }),
        })
        .pipe(Effect.mapError(failed("Could not stop the thread")));
      return stopped.type === "interrupt_requested" ? ("stopped" as const) : ("ended" as const);
    }),
  });
});

export const layer = Layer.effect(WorkflowAgents, make);
