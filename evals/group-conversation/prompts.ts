// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import {
  OrchestrationV2HistoricalMessage,
  ThreadId,
  type OrchestrationV2ThreadGroup,
} from "@t3tools/contracts";
import { renderHistory } from "@t3tools/provider-core/server/handoffBudget";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { makeSideChatContext } from "../../apps/server/src/orchestration-v2/ContextHandoffService.ts";
import { type GroupEntry } from "../../apps/server/src/orchestration-v2/GroupConversation.ts";
import {
  renderPrimaryGroupNote,
  renderPrimaryWakePrompt,
  renderSeatFirstPrompt,
  renderSeatTurnPrompt,
} from "../../apps/server/src/orchestration-v2/GroupPrompt.ts";
import type { BehaviorCase, Exchange } from "./cases.ts";

export const primary = { label: "Rowan", handle: "rowan" };
export const peer = { label: "Kai", handle: "kai" };
export const peerId = ThreadId.make("thread:kai");
export const group = (): OrchestrationV2ThreadGroup => ({
  status: "active",
  primary: { ...primary, model: "assistant" },
  seats: [{ ...peer, threadId: peerId, status: "seated", joinedAfterRun: 0 }],
  discussion: null,
  closedBecause: null,
  closedAt: null,
});

export const delta = (entries: ReadonlyArray<Exchange>) =>
  entries.map((entry) => ({ ...entry, model: null }));
export const digest = (entries: ReadonlyArray<Exchange>, seat = false) =>
  makeSideChatContext({
    parentThreadId: ThreadId.make("thread:main"),
    digest: entries.map((entry) => `[${entry.label}] ${entry.text}`),
    seat,
  });

const decodeHistoricalMessage = Schema.decodeSync(OrchestrationV2HistoricalMessage);
export const publicHistory = (entries: ReadonlyArray<Exchange>) =>
  renderHistory(
    entries.map((entry, index) =>
      decodeHistoricalMessage({
        role: entry.label === "Rowan" ? "assistant" : "user",
        text: entry.text,
        ...(entry.label === "Kai" ? { speaker: { label: entry.label, model: "assistant" } } : {}),
        threadId: "thread:main",
        runId: `run:${index}`,
        itemId: `item:${index}`,
        providerThreadId: null,
        status: "completed",
        kind: entry.label === "Kai" ? "peer_reply" : "assistant_message",
      }),
    ),
    "Conversation context:",
  );

export const wake = (entries: ReadonlyArray<Exchange>) =>
  [
    publicHistory(entries),
    renderPrimaryWakePrompt({ self: primary, others: [peer], from: [peer.label] }),
  ].join("\n\n");

export function behaviorMessages(fixture: BehaviorCase) {
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  const user = (text: string) => messages.push({ role: "user", text });
  switch (fixture.context) {
    case "seat-first":
      user(
        [
          digest(fixture.prior, true),
          renderSeatFirstPrompt({
            self: peer,
            others: [primary],
            reaction: false,
            delta: delta([...fixture.prior, { label: "User", text: fixture.request }]),
          }),
        ].join("\n\n"),
      );
      break;
    case "seat-reaction": {
      const own = fixture.prior.findIndex((entry) => entry.label === "Kai");
      if (own < 0) throw new Error(`${fixture.id} needs a prior Kai turn.`);
      user(
        renderSeatFirstPrompt({
          self: peer,
          others: [primary],
          reaction: false,
          delta: delta(fixture.prior.slice(0, own)),
        }),
      );
      messages.push({ role: "assistant", text: fixture.prior[own]!.text });
      user(
        renderSeatTurnPrompt({
          delta: delta([
            ...fixture.prior.slice(own + 1),
            ...(fixture.request ? [{ label: "User" as const, text: fixture.request }] : []),
          ]),
          reaction: !fixture.request,
        }),
      );
      break;
    }
    case "seat-after-lead":
      user(
        [
          digest([], true),
          renderSeatFirstPrompt({
            self: peer,
            others: [primary],
            reaction: true,
            delta: delta([{ label: "User", text: fixture.request }, ...fixture.prior]),
          }),
        ].join("\n\n"),
      );
      break;
    case "primary-first":
      user(
        [
          renderPrimaryGroupNote({ self: primary, others: [peer], everyoneAddressed: true }),
          fixture.request,
        ].join("\n\n"),
      );
      break;
    case "primary-wake": {
      const [own, ...others] = fixture.prior;
      if (own?.label !== "Rowan") throw new Error(`${fixture.id} needs Rowan's reply first.`);
      user(
        [
          renderPrimaryGroupNote({ self: primary, others: [peer], everyoneAddressed: true }),
          fixture.request,
        ].join("\n\n"),
      );
      messages.push({ role: "assistant", text: own.text });
      user(wake(others));
      break;
    }
    case "primary-return":
      user(publicHistory(fixture.prior));
      user(fixture.request);
      break;
    case "side-chat":
      user([digest(fixture.prior), fixture.request].join("\n\n"));
      break;
    case "ordinary":
      user(fixture.request);
      break;
  }
  return messages;
}

export const productTools = Object.values(OrchestratorToolkit.tools).filter((tool) =>
  ["delegate_task", "orchestrator_capabilities"].includes(tool.name),
);
export const productInputs = new Map(
  productTools.map((tool) => [
    String(tool.name),
    Schema.decodeUnknownSync(
      Schema.toCodecJson(tool.parametersSchema as Schema.Codec<unknown, unknown>),
    ),
  ]),
);
export const delegateTools = productTools.map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  parameters: advertisedJsonSchema(tool),
}));
export const fileTools = [
  {
    name: "read_file",
    description: "Read a workspace file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Replace the contents of a workspace file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

export async function policy(parallel: boolean) {
  const source = NodeFS.readFileSync(
    new URL("../../apps/server/src/orchestration-v2/GroupConversation.ts", import.meta.url),
    "utf8",
  );
  const anchor = /^export const GROUP_PARALLEL = (?:true|false);$/gm;
  if ([...source.matchAll(anchor)].length !== 1)
    throw new Error("GROUP_PARALLEL anchor changed; inspect the scheduler before running.");
  const code = NodeModule.stripTypeScriptTypes(
    source.replace(anchor, `export const GROUP_PARALLEL = ${parallel};`),
  );
  const module: typeof import("../../apps/server/src/orchestration-v2/GroupConversation.ts") =
    await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module;
}

export const groupEntry = (entry: Exchange, ordinal: number): GroupEntry => ({
  ...entry,
  ordinal,
  runOrdinal: ordinal,
  speaker: entry.label === "User" ? "user" : entry.label === "Rowan" ? "primary" : peerId,
  model: null,
  messageId: null,
});
