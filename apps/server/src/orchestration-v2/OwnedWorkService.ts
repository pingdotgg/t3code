import {
  type OrchestrationV2ListOwnedWorkInput,
  type OrchestrationV2ListOwnedWorkResult,
  type OwnedWorkItem,
  type ProjectId,
  type ServerSettingsError,
  type ThreadId,
  openOwnedWorkCountForThread,
  ownedWorkInboxRelevant,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ServerSettings from "../serverSettings.ts";
import { decideOwnedWorkCommand, type OwnedWorkCommand } from "./OwnedWorkDecider.ts";

export class OwnedWorkService extends Context.Service<
  OwnedWorkService,
  {
    readonly list: (
      input: OrchestrationV2ListOwnedWorkInput,
    ) => Effect.Effect<OrchestrationV2ListOwnedWorkResult, never>;
    readonly itemsFor: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<OwnedWorkItem>, never>;
    readonly openCountForThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<number, never>;
    readonly inboxItemsFor: (input: {
      readonly projectId: ProjectId;
      readonly actorThreadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<OwnedWorkItem>, never>;
    readonly dispatch: (
      command: OwnedWorkCommand,
    ) => Effect.Effect<ReadonlyArray<OwnedWorkItem>, string | ServerSettingsError>;
  }
>()("t3/orchestration-v2/OwnedWorkService") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const itemsForImpl = Effect.fn("OwnedWorkService.itemsFor")(function* (projectId: ProjectId) {
    const settings = yield* serverSettings.getSettings;
    return settings.ownedWorkByProject[projectId] ?? [];
  });
  const itemsFor = (projectId: ProjectId) => itemsForImpl(projectId).pipe(Effect.orDie);

  const listImpl = Effect.fn("OwnedWorkService.list")(function* (
    input: OrchestrationV2ListOwnedWorkInput,
  ) {
    const items = yield* itemsFor(input.projectId);
    const sorted = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { items: sorted } satisfies OrchestrationV2ListOwnedWorkResult;
  });
  const list = (input: OrchestrationV2ListOwnedWorkInput) => listImpl(input).pipe(Effect.orDie);

  const openCountForThreadImpl = Effect.fn("OwnedWorkService.openCountForThread")(
    function* (input: { readonly projectId: ProjectId; readonly threadId: ThreadId }) {
      const items = yield* itemsFor(input.projectId);
      return openOwnedWorkCountForThread(items, input.threadId);
    },
  );
  const openCountForThread = (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => openCountForThreadImpl(input).pipe(Effect.orDie);

  const inboxItemsForImpl = Effect.fn("OwnedWorkService.inboxItemsFor")(function* (input: {
    readonly projectId: ProjectId;
    readonly actorThreadId: ThreadId;
  }) {
    const items = yield* itemsFor(input.projectId);
    return items.filter((item) => ownedWorkInboxRelevant(item, input.actorThreadId));
  });
  const inboxItemsFor = (input: {
    readonly projectId: ProjectId;
    readonly actorThreadId: ThreadId;
  }) => inboxItemsForImpl(input).pipe(Effect.orDie);

  const dispatch = Effect.fn("OwnedWorkService.dispatch")(function* (command: OwnedWorkCommand) {
    const settings = yield* serverSettings.getSettings;
    const existing = settings.ownedWorkByProject[command.projectId] ?? [];
    const now = yield* DateTime.now;
    const decided = decideOwnedWorkCommand({
      projectId: command.projectId,
      items: existing,
      command,
      now,
    });
    if (Result.isFailure(decided)) return yield* Effect.fail(decided.failure);
    yield* serverSettings.updateSettings({
      ownedWorkByProject: {
        ...settings.ownedWorkByProject,
        [command.projectId]: [...decided.success],
      },
    });
    return decided.success;
  });

  return OwnedWorkService.of({ list, itemsFor, openCountForThread, inboxItemsFor, dispatch });
});

export const layer: Layer.Layer<OwnedWorkService, never, ServerSettings.ServerSettingsService> =
  Layer.effect(OwnedWorkService, make);
