#!/usr/bin/env node
// T3's context handoff functions on fixed inputs: `handoffBudget.ts` (history selection,
// rendering, cost and budget), `ContextHandoffService.ts` (`prepareForkDelta`,
// `visibleDeltaRunOrdinals`) and `ContextHandoffDelivery.ts` (`deliverContextHandoffs`).
// Writes `src/handoff-cases.json`; `--check` fails when T3's answers changed. The Rust test
// `handoff::tests::handoff_functions_match_t3s` must give the same values. No model, no CLI.
import * as fs from "node:fs";
import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

const pkg = packageImporter("apps/server");
const [Effect, Layer, ConfigProvider] = await Promise.all([
  pkg("effect/Effect"), pkg("effect/Layer"), pkg("effect/ConfigProvider"),
]);
const budgetModule = await importSource("packages/provider-core/src/server/handoffBudget.ts");
const IdAllocator = await importSource("packages/provider-core/src/server/IdAllocator.ts");
const Service = await importSource("apps/server/src/orchestration-v2/ContextHandoffService.ts");
const { deliverContextHandoffs } = await importSource("apps/server/src/orchestration-v2/ContextHandoffDelivery.ts");
const { historicalMessage, selectHistory, renderHistory, historyResponseItems, historyCost, handoffBudget, handoffTokenCapConfig } = budgetModule;

const cases = [];
const add = (kind, input, expected) => cases.push({ kind, input, expected });

const at = "2026-11-20T00:00:00.000Z";
const base = (fields) => ({
  threadId: "thread-fork", runId: "run:thread-fork:1", nodeId: "node:root", providerThreadId: "provider-thread:fork",
  providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 1, status: "completed", title: null,
  startedAt: at, completedAt: at, updatedAt: at, ...fields,
});
const long = "word ".repeat(80) + "😀".repeat(5) + "\n\tend";
const items = [
  base({ id: "item-user", type: "user_message", text: "Remember the  marker\n\nfork-1." }),
  base({ id: "item-assistant", type: "assistant_message", text: "fork marker stored" }),
  base({ id: "item-command", type: "command_execution", input: "ls -la", output: "a\nb", exitCode: 0 }),
  base({ id: "item-command-unknown", type: "command_execution", input: "sleep 1", output: null, exitCode: null }),
  base({ id: "item-error", type: "error", failure: { message: "It broke." } }),
  base({ id: "item-interrupt", type: "run_interrupt_result", message: "Stopped." }),
  base({ id: "item-files", type: "file_change", fileName: "a.rs", changes: [{ path: "src/a.rs" }, { path: "src/b.rs" }] }),
  base({ id: "item-file", type: "file_change", fileName: "only.rs", changes: [] }),
  base({ id: "item-plan", type: "proposed_plan", markdown: "1. Do it" }),
  base({ id: "item-checkpoint", type: "checkpoint", files: [{ path: "a" }, { path: "b" }] }),
  base({ id: "item-handoff", type: "handoff", summary: null, strategy: "fork_delta_summary" }),
  base({ id: "item-long", type: "assistant_message", text: long, runId: null, providerThreadId: null }),
  base({ id: "item-reasoning", type: "reasoning", text: "hidden" }),
];
for (const item of items) add("historicalMessage", item, historicalMessage(item));

const messages = items.map(historicalMessage).filter((m) => m !== null);
const withRunStatus = messages.map((m, i) => (i === 1 ? { ...m, runStatus: "completed" } : m));
for (const context of ["", "Coverage line"]) {
  add("renderHistory", { messages: withRunStatus, context }, renderHistory(withRunStatus, context));
  add("responseItems", { messages: withRunStatus, context }, historyResponseItems(withRunStatus, context));
  add("historyCost", { messages: withRunStatus, context }, historyCost(withRunStatus, context));
}
for (const budget of [0, 500, 1_200, 1_800, 2_600, 4_000, 16_000]) {
  for (const [omittedItems, omittedItemIds] of [[0, []], [3, ["old-1", "old-2", "old-3"]]]) {
    const input = { messages, coverage: "Provider context handoff. Thread: t.", omittedItems, omittedItemIds, budget };
    add("selectHistory", input, selectHistory(input));
  }
}
const manyIds = Array.from({ length: 30 }, (_, i) => `omitted-item-${"x".repeat(i)}`);
for (const budget of [400, 3_000]) {
  const input = { messages: messages.slice(0, 2), coverage: "Cov", omittedItems: 30, omittedItemIds: manyIds, budget };
  add("selectHistory", input, selectHistory(input));
}

const thread = (usage) => ({ contextUsage: usage });
for (const [usage, nativeEstimate, modelWindow, userText, attachments] of [
  [null, 0, undefined, "hello", []],
  [{ usedTokens: 100_000, maxTokens: 128_000 }, 0, undefined, "hello", []],
  [{ usedTokens: 10, maxTokens: 200_000, autoCompactThreshold: 150_000 }, 0, 1_000_000, "x".repeat(5000), [{ type: "image" }, { type: "file" }]],
  [{ maxTokens: 32_000 }, 4_000, undefined, "é😀", []],
  [null, 120_000, undefined, "hello", []],
  [null, 0, 20_000, "hello", []],
]) {
  for (const tokenCap of [16_000, 1_024, 64_000]) {
    const input = { tokenCap, userText, attachments, usage, nativeEstimate, ...(modelWindow === undefined ? {} : { modelWindow }) };
    add("budget", input, handoffBudget({ tokenCap, userText, attachments, providerThread: thread(usage), nativeContextEstimate: nativeEstimate, modelContextWindow: modelWindow }));
  }
}
for (const value of [null, "100", "2000", "999999", "abc", " 5000 "]) {
  const env = value === null ? {} : { T3CODE_CONTEXT_HANDOFF_TOKEN_CAP: value };
  const cap = await Effect.runPromise(
    Effect.gen(function* () { return yield* handoffTokenCapConfig; }).pipe(
      Effect.orElseSucceed(() => budgetModule.DEFAULT_HANDOFF_TOKEN_CAP),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    ),
  );
  add("tokenCap", value, cap);
}

const runs = [
  { id: "run:thread-fork:1", ordinal: 1 }, { id: "run:thread-fork:2", ordinal: 2 }, { id: "run:thread-fork:3", ordinal: 3 },
];
for (const deltaItems of [[], items.slice(0, 2), [items[0], { ...items[1], runId: "run:thread-fork:3" }, { ...items[2], runId: null }], [{ ...items[0], runId: "run:missing" }]]) {
  add("deltaOrdinals", { runs, items: deltaItems }, Service.visibleDeltaRunOrdinals({ runs }, deltaItems));
}

const service = await Effect.runPromise(Effect.gen(function* () {
  return yield* Service.ContextHandoffServiceV2;
}).pipe(Effect.provide(Service.layer.pipe(Layer.provide(IdAllocator.layer)))));
const forkInput = (fields) => ({
  sourceThreadId: "thread-fork", targetThreadId: "thread-parent", targetRunId: "run:thread-parent:2",
  transferId: "context-transfer:merge", fromProviderThreadIds: ["provider-thread:fork"], toProviderThreadId: "provider-thread:parent",
  fromProviderInstanceId: "claudeAgent", toProviderInstanceId: "claudeAgent", createdAt: at, ...fields,
});
for (const fork of [
  { deltaItems: items, coveredRunOrdinals: { from: 1, to: 2 } },
  { deltaItems: [], coveredRunOrdinals: { from: 1, to: 1 } },
  { deltaItems: items.slice(0, 2), coveredRunOrdinals: { from: 1, to: 1 } },
  { deltaItems: [items[11], items[9]], coveredRunOrdinals: { from: 2, to: 2 } },
]) {
  const input = forkInput(fork);
  const handoff = await Effect.runPromise(service.prepareForkDelta(input));
  const { fromProviderInstanceId: _from, toProviderInstanceId: _to, ...recorded } = input;
  add("forkDelta", recorded, { ...JSON.parse(JSON.stringify(handoff)), id: "handoff-id" });
}

// `deliverContextHandoffs`: what it injects or inlines, and each record it persists.
const ready = await Effect.runPromise(service.prepareForkDelta(forkInput({ coveredRunOrdinals: { from: 1, to: 1 }, deltaItems: items })));
const handoff = { ...JSON.parse(JSON.stringify(ready)), id: "handoff-id" };
const second = { ...handoff, id: "handoff-2", history: { ...handoff.history, messages: handoff.history.messages.slice(0, 3), omittedItems: 2, omittedItemIds: ["gone-1", "gone-2"] } };
const { history: _history, ...withoutHistory } = handoff;
const legacy = { ...withoutHistory, id: "handoff-legacy", strategy: "manual_context", summaryText: "Older summary text." };
const delivered = { ...handoff, delivery: { nativeThreadId: "native-1", status: "inline", itemIds: [], omittedItemIds: [] } };
const pendingDelivery = { ...handoff, delivery: { nativeThreadId: "native-1", status: "pending", itemIds: [], omittedItemIds: [] } };
for (const [handoffs, nativeThreadId, budget, alreadyDelivered, inject] of [
  [[handoff], "native-1", 16_000, [], false],
  [[handoff], "native-1", 16_000, [], true],
  [[handoff], null, 16_000, [], false],
  [[handoff], null, 16_000, [], true],
  [[handoff], "native-1", 900, [], false],
  [[handoff], "native-1", 50, [], false],
  [[handoff, second], "native-1", 16_000, [handoff.history.messages[0].itemId], false],
  [[legacy], "native-1", 16_000, [], false],
  [[legacy], "native-1", 600, [], false],
  [[delivered], "native-1", 16_000, [], false],
  [[delivered], "native-2", 16_000, [], true],
  [[pendingDelivery], "native-1", 16_000, [], true],
  [[pendingDelivery], "native-1", 16_000, [], false],
  [Array.from({ length: 12 }, (_, i) => ({ ...handoff, id: `h-${i}` })), "native-1", 4_000, [], false],
]) {
  const persisted = [];
  let injected = null;
  const input = { handoffs, nativeThreadId, budget, alreadyDelivered, inject };
  const outcome = await Effect.runPromise(Effect.result(Effect.gen(function* () {
    const result = yield* deliverContextHandoffs({
      handoffs,
      providerThread: { appThreadId: "thread-parent", nativeThreadRef: nativeThreadId === null ? null : { nativeId: nativeThreadId } },
      budget,
      alreadyDeliveredItemIds: new Set(alreadyDelivered),
      ...(inject ? { inject: (history) => Effect.sync(() => { injected = JSON.parse(JSON.stringify(history)); return true; }) } : {}),
      persist: (record) => Effect.sync(() => { persisted.push(record.delivery ?? null); }),
    });
    yield* result.delivered;
    return result.context;
  })));
  add("deliver", input, outcome._tag === "Failure"
    ? { error: outcome.failure.message }
    : persisted.length === 0 ? { context: outcome.success, persisted } : { context: outcome.success, persisted, injected });
}

const out = "[\n" + cases.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n";
const path = new URL("../src/handoff-cases.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (fs.readFileSync(path, "utf8") !== out) throw new Error("T3's handoff functions changed; run gen-handoff-cases.mjs and port the difference");
  console.log(`handoff characterizations: ${cases.length} T3 cases current`);
} else {
  fs.writeFileSync(path, out);
  console.log(`recorded ${cases.length} handoff characterizations from T3`);
}
