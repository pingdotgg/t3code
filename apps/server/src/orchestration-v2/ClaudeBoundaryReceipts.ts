import {
  CommandId,
  ClaudeSettings,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { readClaudeBoundaryReceipts } from "./Adapters/ClaudeSavedMessageReceipts.ts";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

function legacyContext(message: OrchestrationV2ConversationMessage, offerId: string) {
  const author = message.createdBy === "user" ? "the user" : "another agent";
  return `From ${author} (delivery ${offerId}):\n${projectComposerContextForProvider({
    text: message.text,
    records: message.context?.records ?? [],
  })}`;
}

export const makeClaudeBoundaryReceiptRecovery = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  return Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    for (const threadId of yield* projections.getRecoveryThreadIds("boundary-offers")) {
      yield* Effect.gen(function* () {
        const queued = yield* threads.getThreadRecords(threadId, ["runs"], {
          runStatuses: ["queued"],
        });
        if (queued.thread.archivedAt !== null || queued.thread.deletedAt !== null) return;
        const offered = queued.runs.filter(
          (run) => run.status === "queued" && run.boundaryOffer !== undefined,
        );
        const projection = yield* threads.getThreadRecords(
          threadId,
          ["messages", "providerTurns", "providerThreads"],
          {
            messageIds: offered.map((run) => run.userMessageId),
          },
        );
        const grouped = new Map<
          string,
          { home: string; nativeThreadId: string; runs: typeof offered }
        >();
        for (const run of offered) {
          const turn = projection.providerTurns.find(
            (candidate) => candidate.id === run.boundaryOffer!.providerTurnId,
          );
          if (turn === undefined) continue;
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === turn.providerThreadId,
          );
          const nativeId = providerThread?.nativeThreadRef?.nativeId;
          const instance =
            providerThread === undefined
              ? undefined
              : settings.providerInstances[providerThread.providerInstanceId];
          if (nativeId == null || instance?.driver !== "claudeAgent") continue;
          // A secret config-directory override cannot be reconstructed from redacted settings.
          if (
            instance.environment?.some(
              (variable) =>
                variable.name.toUpperCase() === "CLAUDE_CONFIG_DIR" &&
                typeof variable.value !== "string",
            )
          )
            continue;
          const config = yield* decodeClaudeSettings(instance.config ?? {});
          const merged = yield* mergeProviderInstanceEnvironment(instance.environment, environment);
          const home = yield* resolveClaudeHomePath(config, merged);
          const key = `${home}\0${nativeId}`;
          const group = grouped.get(key);
          if (group === undefined)
            grouped.set(key, { home, nativeThreadId: nativeId, runs: [run] });
          else group.runs.push(run);
        }
        for (const { home, nativeThreadId, runs } of grouped.values()) {
          const saved = yield* readClaudeBoundaryReceipts({
            projectsDirectory: path.join(home, "projects"),
            nativeThreadId,
            offers: runs.map((run) => {
              const message = projection.messages.find(
                (candidate) => candidate.id === run.userMessageId,
              );
              return {
                id: run.boundaryOffer!.id,
                ...(message === undefined
                  ? {}
                  : { legacyContext: legacyContext(message, run.boundaryOffer!.id) }),
              };
            }),
          });
          for (const run of runs) {
            const offer = run.boundaryOffer!;
            if (!saved.has(offer.id)) continue;
            yield* positions.reserveBoundary({
              threadId,
              turnItemId: ids.derive.userTurnItem({ messageId: run.userMessageId }),
              runId: offer.targetRunId,
              queuedRunId: run.id,
              offerId: offer.id,
              providerTurnId: offer.providerTurnId,
            });
            yield* threads.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make(`tool-boundary-receipt:${offer.id}`),
              threadId,
              queuedRunId: run.id,
              targetRunId: offer.targetRunId,
              boundaryOffer: { id: offer.id, step: "receipt" },
            });
          }
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Claude saved-message recovery left offers unconfirmed", {
            threadId,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.withSpan("recoverClaudeBoundaryReceipts"),
  );
});
