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

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkflowAgentLinks from "./WorkflowAgentLinks.ts";
import { isProjectPath, WorkflowAgentError, WorkflowAgents } from "./WorkflowAgents.ts";

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
          runtimeMode: defaults.defaultRuntimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
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
      return { threadId: launched.threadId, turnId: run.id };
    }),
    result: Effect.fn("WorkflowAgentThreads.result")(function* (turn) {
      const environment = elsewhere(turn.environment);
      if (environment !== undefined) return yield* linked.result(turn, environment);
      const threadId = ThreadId.make(turn.threadId);
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(failed("Could not read the thread")));
      if (shell === null) {
        return yield* new WorkflowAgentError({
          reason: `Thread ${turn.threadId} no longer exists.`,
        });
      }
      while (true) {
        const waited = yield* threads
          .waitForThread({
            projectId: shell.projectId,
            threadId,
            runId: turn.turnId as RunId,
            timeoutMs: Duration.toMillis(WAIT_SLICE),
          })
          .pipe(Effect.mapError(failed("Could not wait for the turn")));
        const run = waited.run;
        if (waited.timedOut || run === null) continue;
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
      if (environment !== undefined) return yield* linked.interrupt(target.threadId, environment);
      const thread = target.threadId;
      const threadId = ThreadId.make(thread);
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(failed("Could not read the thread")));
      if (shell === null) return;
      yield* threads
        .interruptThread({
          projectId: shell.projectId,
          threadId,
          commandId: CommandId.make(
            `workflow:interrupt:${thread}:${yield* Clock.currentTimeMillis}`,
          ),
          reason: "Its workflow run was cancelled",
        })
        .pipe(Effect.mapError(failed("Could not stop the thread")));
    }),
  });
});

export const layer = Layer.effect(WorkflowAgents, make);
