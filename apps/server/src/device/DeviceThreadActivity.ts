import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/** Whether a thread may still be driving its devices, so a takeover must leave them alone. */
export class DeviceThreadActivity extends Context.Service<
  DeviceThreadActivity,
  {
    readonly isActive: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  }
>()("t3/device/DeviceThreadActivity") {}

export const layer = Layer.effect(
  DeviceThreadActivity,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return DeviceThreadActivity.of({
      // Background commands and subagents outlive their run and can still run agent-device.
      isActive: Effect.fn("DeviceThreadActivity.isActive")(function* (threadId: ThreadId) {
        const shell = yield* projections.getThreadShell(threadId);
        return (
          shell !== null &&
          (shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0)
        );
      }),
    });
  }),
);
