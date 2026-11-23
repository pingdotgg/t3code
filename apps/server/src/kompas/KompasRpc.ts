import { KOMPAS_WS_METHODS, type KompasSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { KompasDatabase } from "./KompasDatabase.ts";
import { KompasSettingsStore } from "./KompasSettingsStore.ts";
import { LearningService } from "./LearningService.ts";
import { MemoryService } from "./MemoryService.ts";
import { PluginService } from "./PluginService.ts";
import { PluginStore } from "./PluginStore.ts";
import { WorkstreamService } from "./WorkstreamService.ts";
import { WorkstreamStore } from "./WorkstreamStore.ts";

const make = Effect.gen(function* () {
  const database = yield* KompasDatabase;
  const settings = yield* KompasSettingsStore;
  const pluginStore = yield* PluginStore;
  const plugins = yield* PluginService;
  const memory = yield* MemoryService;
  const learning = yield* LearningService;
  const workstreams = yield* WorkstreamService;
  const workstreamStore = yield* WorkstreamStore;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;

  const snapshot = Effect.gen(function* () {
    const chatProject = yield* folders.ensureScratchProject.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Conversations have no folder.", { cause }).pipe(Effect.as(null)),
      ),
    );
    return {
      settings: yield* settings.get,
      chatProjectId: chatProject?.projectId ?? null,
      plugins: yield* pluginStore.list,
      pluginThreads: yield* pluginStore.threadOverrides,
      memory: yield* memory.list,
      decks: yield* learning.decks,
      workstreams: yield* workstreams.list,
    } satisfies KompasSnapshot;
  }).pipe(Effect.withSpan("KompasRpc.snapshot"));

  return {
    [KOMPAS_WS_METHODS.subscribe]: () =>
      database.changes.pipe(Stream.mapEffect(() => snapshot)),
    [KOMPAS_WS_METHODS.updateSettings]: settings.update,
    [KOMPAS_WS_METHODS.savePlugin]: plugins.save,
    [KOMPAS_WS_METHODS.removePlugin]: ({ id }: { readonly id: string }) => plugins.remove(id),
    [KOMPAS_WS_METHODS.testPlugin]: ({ id }: { readonly id: string }) => plugins.test(id),
    [KOMPAS_WS_METHODS.signInPlugin]: plugins.signIn,
    [KOMPAS_WS_METHODS.setPluginForThread]: pluginStore.setForThread,
    [KOMPAS_WS_METHODS.saveMemory]: memory.saveFromUser,
    [KOMPAS_WS_METHODS.removeMemory]: ({ id }: { readonly id: string }) => memory.remove(id),
    [KOMPAS_WS_METHODS.resolveMemory]: memory.resolve,
    [KOMPAS_WS_METHODS.listCards]: (input: Parameters<typeof learning.cards>[0]) =>
      learning.cards(input).pipe(Effect.map((cards) => ({ cards }))),
    [KOMPAS_WS_METHODS.reviewCard]: learning.review,
    [KOMPAS_WS_METHODS.saveCard]: ({
      id,
      deckId,
      ...card
    }: {
      readonly id?: string;
      readonly deckId: string;
      readonly front: string;
      readonly back: string;
      readonly hint: string | null;
    }) =>
      id === undefined
        ? learning.addCards({ deckId, cards: [card], threadId: null }).pipe(Effect.asVoid)
        : learning.editCard({ id, ...card }).pipe(Effect.asVoid),
    [KOMPAS_WS_METHODS.removeCard]: ({ id }: { readonly id: string }) => learning.removeCard(id),
    [KOMPAS_WS_METHODS.saveDeck]: (input: { readonly id?: string; readonly title: string }) =>
      input.id === undefined
        ? learning
            .createDeck({ title: input.title, cards: [], threadId: null })
            .pipe(Effect.map(({ id }) => ({ id })))
        : learning
            .renameDeck({ id: input.id, title: input.title })
            .pipe(Effect.as({ id: input.id })),
    [KOMPAS_WS_METHODS.removeDeck]: ({ id }: { readonly id: string }) => learning.removeDeck(id),
    [KOMPAS_WS_METHODS.exportDeck]: ({ id }: { readonly id: string }) => learning.exportCsv(id),
    [KOMPAS_WS_METHODS.studyStats]: () => learning.stats,
    [KOMPAS_WS_METHODS.createWorkstream]: workstreams.create,
    [KOMPAS_WS_METHODS.updateWorkstream]: ({
      id,
      ...fields
    }: Parameters<typeof workstreamStore.update>[1] & { readonly id: string }) =>
      workstreamStore.update(id, fields),
    [KOMPAS_WS_METHODS.removeWorkstream]: ({ id }: { readonly id: string }) =>
      workstreams.remove(id),
    [KOMPAS_WS_METHODS.addLibraryItem]: (
      input: Omit<Parameters<typeof workstreamStore.addLibraryItem>[0], "threadId">,
    ) => workstreamStore.addLibraryItem({ ...input, threadId: null }).pipe(Effect.asVoid),
    [KOMPAS_WS_METHODS.removeLibraryItem]: ({ id }: { readonly id: string }) =>
      workstreamStore.removeLibraryItem(id),
    [KOMPAS_WS_METHODS.resolveSuggestion]: workstreams.resolveSuggestion,
    [KOMPAS_WS_METHODS.answerDecision]: workstreams.answerDecision,
    [KOMPAS_WS_METHODS.setThreadResolved]: workstreamStore.setResolved,
  };
});

/** The handlers `ws.ts` spreads into its own, so that file has one line to merge. */
export class KompasRpc extends Context.Service<KompasRpc, Effect.Success<typeof make>>()(
  "t3/kompas/KompasRpc",
) {}

export const layer = Layer.effect(KompasRpc, make);
