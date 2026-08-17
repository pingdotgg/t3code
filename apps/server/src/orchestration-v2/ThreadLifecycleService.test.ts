import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLifecycle from "./ThreadLifecycleService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect("maps application lifecycle operations to V2-native commands", () => {
  const threadId = ThreadId.make("thread_lifecycle_service");
  const commands: Array<string> = [];
  const projection = { thread: { id: threadId } } as OrchestrationV2ThreadProjection;
  const layer = ThreadLifecycle.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) => {
          commands.push(command.type);
          return Effect.succeed({ sequence: commands.length, storedEvents: [] });
        },
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadLifecycle.ThreadLifecycleService;
    yield* service.archive({ commandId: CommandId.make("archive"), threadId });
    yield* service.unarchive({ commandId: CommandId.make("unarchive"), threadId });
    yield* service.updateMetadata({ commandId: CommandId.make("metadata"), threadId, title: "T" });
    yield* service.setRuntimeMode({
      commandId: CommandId.make("runtime"),
      threadId,
      runtimeMode: "approval-required",
    });
    yield* service.setInteractionMode({
      commandId: CommandId.make("interaction"),
      threadId,
      interactionMode: "plan",
    });
    yield* service.setModelSelection({
      commandId: CommandId.make("model"),
      threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.2" },
    });
    yield* service.delete({ commandId: CommandId.make("delete"), threadId });
    assert.deepEqual(commands, [
      "thread.archive",
      "thread.unarchive",
      "thread.metadata.update",
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
      "thread.model-selection.set",
      "thread.delete",
    ]);
  }).pipe(Effect.provide(layer));
});
