import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ProviderAutoSwitchSettings,
  type RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import { autoSwitchReason, nextAutoSwitchTarget } from "@t3tools/shared/providerAutoSwitch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Commands that move a thread along the auto-switch route once `runId` ends. A run that hit its
 * usage limit switches and continues; a run that finished past the threshold switches so the next
 * message goes to the new provider. The ids derive from the run, so a replayed event is a no-op.
 */
export function autoSwitchCommands(input: {
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "status"
    | "lastErrorClass"
    | "latestRunId"
    | "archivedAt"
    | "settledOverride"
    | "pendingRuntimeRequest"
    | "lineage"
    | "modelSelection"
  >;
  readonly runId: RunId;
  readonly settings: ProviderAutoSwitchSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ReadonlyArray<OrchestrationV2Command> {
  const { thread, runId, settings, providers } = input;
  if (
    settings.mode !== "route" ||
    thread.latestRunId !== runId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    thread.lineage.relationshipToParent === "subagent"
  )
    return [];
  const reason = autoSwitchReason({
    settings,
    providers,
    selection: thread.modelSelection,
    runStatus: thread.status,
    lastErrorClass: thread.lastErrorClass,
  });
  if (reason === null) return [];
  const target = nextAutoSwitchTarget(settings, providers, thread.modelSelection);
  if (target === null) return [];
  const identity = `${thread.id}:${runId}`;
  const commands: Array<OrchestrationV2Command> = [
    {
      type: "provider.switch",
      commandId: CommandId.make(`auto-switch:${identity}`),
      threadId: thread.id,
      modelSelection: target,
    },
  ];
  if (reason === "exhausted") {
    commands.push({
      type: "message.dispatch",
      commandId: CommandId.make(`auto-switch-resume:${identity}`),
      messageId: MessageId.make(`auto-switch-resume:${identity}`),
      threadId: thread.id,
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
  }
  return commands;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry;

    const onRunEnded = Effect.fn("ProviderAutoSwitchWorker.onRunEnded")(function* (run: {
      readonly threadId: OrchestrationV2ThreadShell["id"];
      readonly runId: RunId;
    }) {
      const { providerAutoSwitch } = yield* settings.getSettings;
      if (providerAutoSwitch.mode !== "route") return;
      const thread = yield* projections.getThreadShell(run.threadId);
      if (thread === null) return;
      const commands = autoSwitchCommands({
        thread,
        runId: run.runId,
        settings: providerAutoSwitch,
        providers: yield* registry.getProviders,
      });
      for (const command of commands) yield* threads.dispatch(command);
      if (commands.length > 0) {
        yield* Effect.logInfo("orchestration-v2.provider-auto-switch.switched", {
          threadId: run.threadId,
          from: thread.modelSelection.instanceId,
          to:
            commands[0]?.type === "provider.switch" ? commands[0].modelSelection.instanceId : null,
        });
      }
    });

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" &&
        (event.payload.status === "completed" || event.payload.status === "failed")
          ? onRunEnded({ threadId: event.payload.threadId, runId: event.payload.id }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.provider-auto-switch.failed", {
                  threadId: event.payload.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
    );
  }),
);
