import {
  OrchestratorMcpFailure,
  type AssetResource,
  type BlenderJobOutput,
  type BlenderRequestError,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { issueAssetUrl } from "../../../assets/AssetAccess.ts";
import * as Blender from "../../../blender/Blender.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { BlenderToolkit } from "./tools.ts";

/** Jobs belong to the calling thread; settings and its workspace govern them in Blender. */
const callerThread = Effect.fn("BlenderMcp.callerThread")(function* () {
  const { thread, origin, capabilities } = yield* McpInvocationContext.McpInvocationContext;
  if (thread === undefined || !capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Blender tools act in a thread.",
    });
  }
  return { threadId: thread.threadId, origin };
});

const rejected = (error: BlenderRequestError | ServerSettingsError) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      error._tag === "BlenderRequestError" ? error.message : "Blender settings are unavailable.",
  });

export const layer = McpToolAccess.toLayer(BlenderToolkit, {
  blender_inspect: McpToolAccess.readsAsCaller(({ path }) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread();
      const blender = yield* Blender.Blender;
      const scene = yield* blender.inspect({ threadId, path }).pipe(Effect.mapError(rejected));
      return {
        ...scene,
        objects: scene.objects
          .toSorted((left, right) => Number(right.selected) - Number(left.selected))
          .slice(0, 20),
      };
    }),
  ),
  blender_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread();
      const { limits } = yield* readCaller();
      if (
        limits.interactionMode === "plan" ||
        ((input.script !== undefined || input.saveAs !== undefined) &&
          limits.runtimeMode !== "full-access")
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Leave plan mode to start a Blender job. Scripts and saving scenes require full access.",
        });
      }
      const blender = yield* Blender.Blender;
      return yield* blender
        .startJob({ ...input, threadId }, { notifyAgent: true })
        .pipe(Effect.mapError(rejected));
    }),
  ),
  blender_job: McpToolAccess.readsAsCaller(({ jobId }) =>
    Effect.gen(function* () {
      const { threadId, origin } = yield* callerThread();
      const blender = yield* Blender.Blender;
      const ref = { threadId, jobId };
      const job = yield* blender.getJob(ref).pipe(Effect.mapError(rejected));
      const links: Array<{ output: BlenderJobOutput; url: string }> = [];
      for (const output of job.outputs) {
        if (job.result?.[output] === undefined) continue;
        const resource = { _tag: "blender-output", ...ref, output } satisfies AssetResource;
        const url = yield* blender.outputFile(resource).pipe(
          Effect.flatMap((outputPath) => issueAssetUrl({ resource, outputPath })),
          Effect.map(({ relativeUrl }) =>
            origin ? new URL(relativeUrl, origin).href : relativeUrl,
          ),
          Effect.orElseSucceed(() => null),
        );
        if (url !== null) links.push({ output, url });
      }
      return { job, links };
    }),
  ),
  blender_cancel: McpToolAccess.actsAsCaller(({ jobId }) =>
    Effect.gen(function* () {
      const { threadId } = yield* callerThread();
      const blender = yield* Blender.Blender;
      return yield* blender.cancelJob({ threadId, jobId }).pipe(Effect.mapError(rejected));
    }),
  ),
});
