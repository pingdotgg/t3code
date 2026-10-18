import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { type OrchestrationV2ServerCommand, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const baseInput = {
  title: "Inbox sweep",
  prompt: "Sweep the inbox.",
  enabled: false,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project-hidden-runs",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

it.effect("keeps hideThreads across edits that omit it and hides both kinds of run", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
    const steps = yield* Ref.make<ReadonlyArray<string>>([]);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Ref.update(launches, (all) => [...all, input]).pipe(
            Effect.andThen(Effect.die(new Error("launch stops here"))),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(
            Effect.andThen(Ref.update(steps, (all) => [...all, "hide"])),
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
        sendToThread: () =>
          Ref.update(steps, (all) => [...all, "send"]).pipe(
            Effect.andThen(Effect.die(new Error("send stops here"))),
          ),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* decodeUpsertInput({ ...baseInput, hideThreads: true }),
      );
      expect(created.task.hideThreads).toBe(true);

      const edited = yield* service.upsert(
        yield* decodeUpsertInput({ ...baseInput, id: created.task.id, title: "Renamed" }),
      );
      expect(edited.task.hideThreads).toBe(true);

      yield* service.runNow({ id: created.task.id });
      expect((yield* Ref.get(launches)).map((input) => input.hidden)).toEqual([true]);

      const bound = yield* service.upsert(
        yield* decodeUpsertInput({
          ...baseInput,
          id: created.task.id,
          threadId: "thread-bound-hidden",
        }),
      );
      yield* service.runNow({ id: bound.task.id });
      const commands = yield* Ref.get(dispatched);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.hidden.set",
        threadId: "thread-bound-hidden",
        hidden: true,
      });
      expect(yield* Ref.get(steps)).toEqual(["hide", "send"]);

      const shown = yield* service.upsert(
        yield* decodeUpsertInput({ ...baseInput, id: created.task.id, hideThreads: false }),
      );
      expect(shown.task.hideThreads).toBe(false);
      yield* service.runNow({ id: shown.task.id });
      expect((yield* Ref.get(launches)).map((input) => input.hidden)).toEqual([true, false]);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
