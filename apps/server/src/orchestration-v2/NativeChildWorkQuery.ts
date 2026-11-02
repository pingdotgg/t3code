import {
  isProviderNativeSubagentThread,
  OrchestrationV2GetNativeChildWorkError,
  type OrchestrationV2GetNativeChildWorkInput,
  type OrchestrationV2GetNativeChildWorkResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { readAntigravityChildWork } from "../provider/acp/AntigravityChildWork.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** Reads what a provider-native subagent's children did, on demand. Other providers stream real child sessions. */
export class NativeChildWorkQuery extends Context.Service<
  NativeChildWorkQuery,
  {
    readonly getNativeChildWork: (
      input: OrchestrationV2GetNativeChildWorkInput,
    ) => Effect.Effect<
      OrchestrationV2GetNativeChildWorkResult,
      OrchestrationV2GetNativeChildWorkError
    >;
  }
>()("t3/orchestration-v2/NativeChildWorkQuery") {}

const NO_CHILDREN: OrchestrationV2GetNativeChildWorkResult = { children: [] };

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;

  const getNativeChildWork = Effect.fn("NativeChildWorkQuery.getNativeChildWork")(
    function* (input: OrchestrationV2GetNativeChildWorkInput) {
      const { thread } = yield* threads.getThreadRecords(input.threadId, []);
      const parentThreadId = thread.lineage.parentThreadId;
      if (
        !isProviderNativeSubagentThread(thread) ||
        parentThreadId === null ||
        thread.forkedFrom?.type !== "node"
      ) {
        return NO_CHILDREN;
      }
      const subagentId = thread.forkedFrom.nodeId;
      const { subagents } = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
      const subagent = subagents.find(
        (candidate) => candidate.id === subagentId && candidate.childThreadId === thread.id,
      );
      const nativeTaskId = subagent?.nativeTaskRef?.nativeId;
      if (
        subagent?.driver !== "antigravity" ||
        subagent.origin !== "provider_native" ||
        subagent.runId === null ||
        !nativeTaskId
      ) {
        return NO_CHILDREN;
      }
      const others = subagents.filter(
        (candidate) =>
          candidate.id !== subagent.id &&
          candidate.driver === "antigravity" &&
          candidate.origin === "provider_native" &&
          candidate.providerInstanceId === subagent.providerInstanceId,
      );
      const { runs, providerThreads } = yield* threads.getThreadRecords(
        parentThreadId,
        ["runs", "providerThreads"],
        { runIds: [subagent.runId, ...others.flatMap((other) => other.runId ?? [])] },
      );
      const providerThreadOf = (runId: string | null) => {
        const providerThreadId = runs.find((run) => run.id === runId)?.providerThreadId;
        return providerThreads.find((candidate) => candidate.id === providerThreadId);
      };
      const providerThread = providerThreadOf(subagent.runId);
      const rootSessionId = providerThread?.nativeThreadRef?.nativeId;
      if (!rootSessionId || providerThread?.providerInstanceId !== subagent.providerInstanceId) {
        return NO_CHILDREN;
      }
      const directories = yield* resolveAntigravityInstanceDirectories(
        stateDir,
        subagent.providerInstanceId,
      ).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(Path.Path, path));
      const children = yield* readAntigravityChildWork({
        profileDirectory: directories.profile,
        rootSessionId,
        nativeTaskId,
        launch: { title: subagent.title, prompt: subagent.prompt },
        // Only batches from the same agent session can share its records.
        siblings: others.flatMap((other) => {
          const id = other.nativeTaskRef?.nativeId;
          return id && providerThreadOf(other.runId)?.nativeThreadRef?.nativeId === rootSessionId
            ? [{ nativeTaskId: id, title: other.title, prompt: other.prompt }]
            : [];
        }),
      });
      return { children };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetNativeChildWorkError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  return NativeChildWorkQuery.of({ getNativeChildWork });
});

export const layer = Layer.effect(NativeChildWorkQuery, make);
