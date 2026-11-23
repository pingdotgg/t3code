import { type Deck, KOMPAS_WS_METHODS, type Workstream } from "@t3tools/contracts";
import type { EnvironmentId, KompasSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createKompasEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:kompas",
    tag: KOMPAS_WS_METHODS.subscribe,
  });
  const snapshotAtom = (environmentId: EnvironmentId) => live({ environmentId, input: {} });
  // Any change to decks (a card added, reviewed or due) reads the cards again.
  const decksTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    Atom.make((get) => {
      const result = get(snapshotAtom(environmentId));
      return AsyncResult.isSuccess(result) ? result.value.decks : undefined;
    });
  return {
    snapshotAtom,
    cards: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:kompas:cards",
      tag: KOMPAS_WS_METHODS.listCards,
      refreshTrigger: decksTrigger,
    }),
    studyStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:kompas:study-stats",
      tag: KOMPAS_WS_METHODS.studyStats,
      refreshTrigger: decksTrigger,
    }),
    exportDeck: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:export-deck",
      tag: KOMPAS_WS_METHODS.exportDeck,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:update-settings",
      tag: KOMPAS_WS_METHODS.updateSettings,
    }),
    savePlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:save-plugin",
      tag: KOMPAS_WS_METHODS.savePlugin,
    }),
    removePlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:remove-plugin",
      tag: KOMPAS_WS_METHODS.removePlugin,
    }),
    testPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:test-plugin",
      tag: KOMPAS_WS_METHODS.testPlugin,
    }),
    signInPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:sign-in-plugin",
      tag: KOMPAS_WS_METHODS.signInPlugin,
    }),
    setPluginForThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:set-plugin-for-thread",
      tag: KOMPAS_WS_METHODS.setPluginForThread,
    }),
    saveMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:save-memory",
      tag: KOMPAS_WS_METHODS.saveMemory,
    }),
    removeMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:remove-memory",
      tag: KOMPAS_WS_METHODS.removeMemory,
    }),
    resolveMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:resolve-memory",
      tag: KOMPAS_WS_METHODS.resolveMemory,
    }),
    reviewCard: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:review-card",
      tag: KOMPAS_WS_METHODS.reviewCard,
    }),
    saveCard: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:save-card",
      tag: KOMPAS_WS_METHODS.saveCard,
    }),
    removeCard: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:remove-card",
      tag: KOMPAS_WS_METHODS.removeCard,
    }),
    saveDeck: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:save-deck",
      tag: KOMPAS_WS_METHODS.saveDeck,
    }),
    removeDeck: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:remove-deck",
      tag: KOMPAS_WS_METHODS.removeDeck,
    }),
    createWorkstream: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:create-workstream",
      tag: KOMPAS_WS_METHODS.createWorkstream,
    }),
    updateWorkstream: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:update-workstream",
      tag: KOMPAS_WS_METHODS.updateWorkstream,
    }),
    removeWorkstream: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:remove-workstream",
      tag: KOMPAS_WS_METHODS.removeWorkstream,
    }),
    addLibraryItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:add-library-item",
      tag: KOMPAS_WS_METHODS.addLibraryItem,
    }),
    removeLibraryItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:remove-library-item",
      tag: KOMPAS_WS_METHODS.removeLibraryItem,
    }),
    resolveSuggestion: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:resolve-suggestion",
      tag: KOMPAS_WS_METHODS.resolveSuggestion,
    }),
    answerDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:answer-decision",
      tag: KOMPAS_WS_METHODS.answerDecision,
    }),
    setThreadResolved: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:kompas:set-thread-resolved",
      tag: KOMPAS_WS_METHODS.setThreadResolved,
    }),
  };
}

export const dueCardCount = (decks: ReadonlyArray<Deck>) =>
  decks.reduce((total, deck) => total + deck.dueCount, 0);

/** Threads, questions and proposals of a project that wait for the user. */
export const waitingForUser = (workstream: Workstream) =>
  workstream.threads.filter((thread) => thread.state === "needs_input").length +
  workstream.decisions.length +
  workstream.suggestions.length;

/** The board's order: what needs the user first, what is done last. */
export const WORKSTREAM_STATES = ["needs_input", "working", "idle", "failed", "resolved"] as const;

/** Entries of one memory scope, with how full it is. */
export const memoryInScope = (snapshot: KompasSnapshot, scope: string) => {
  const entries = snapshot.memory.filter(
    (entry) => entry.scope === scope && entry.status === "saved",
  );
  return { entries, used: entries.reduce((total, entry) => total + entry.text.length, 0) };
};

export const pluginEnabledInThread = (
  snapshot: KompasSnapshot,
  pluginId: string,
  threadId: string,
) => {
  const override = snapshot.pluginThreads.find(
    (entry) => entry.pluginId === pluginId && entry.threadId === threadId,
  );
  const plugin = snapshot.plugins.find((entry) => entry.id === pluginId);
  return plugin?.enabled === true && (override?.enabled ?? plugin.allConversations);
};

/** Ready-made plugins for the "Add plugin" screen. */
export const PLUGIN_CATALOG = [
  {
    name: "exa",
    brand: "Exa",
    url: "https://mcp.exa.ai/mcp",
    keyHeader: "x-api-key",
    keyPrefix: "",
    keyless: true,
    docs: "https://exa.ai/docs/get-started/exa-mcp",
  },
  {
    name: "tavily",
    brand: "Tavily",
    url: "https://mcp.tavily.com/mcp/",
    keyHeader: "Authorization",
    keyPrefix: "Bearer ",
    keyless: false,
    docs: "https://docs.tavily.com/documentation/mcp",
  },
] as const;

/** Time until a rating shows the card again, short enough for a button. */
export const dueInLabel = (due: string, nowMs: number, locale: string) => {
  const format = (value: number, unit: "minute" | "hour" | "day" | "month") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
  const minutes = Math.max(1, Math.round((Date.parse(due) - nowMs) / 60_000));
  if (minutes < 60) return format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format(hours, "hour");
  const days = Math.round(hours / 24);
  return days < 60 ? format(days, "day") : format(Math.round(days / 30), "month");
};
