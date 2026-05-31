import "./t3work-sdk.globals.ts";

import { defineModel } from "./t3work-sdk.ts";

export const models = {
  openai: {
    gpt5_4: defineModel({ provider: "openai", id: "gpt-5.4" }),
    gpt5_4Mini: defineModel({ provider: "openai", id: "gpt-5.4-mini" }),
    gpt5_3Codex: defineModel({ provider: "openai", id: "gpt-5.3-codex" }),
    gpt5_3CodexSpark: defineModel({ provider: "openai", id: "gpt-5.3-codex-spark" }),
  },
  anthropic: {
    claudeHaiku45: defineModel({ provider: "anthropic", id: "claude-haiku-4-5" }),
    claudeSonnet46: defineModel({ provider: "anthropic", id: "claude-sonnet-4-6" }),
    claudeOpus46: defineModel({ provider: "anthropic", id: "claude-opus-4-6" }),
    claudeOpus47: defineModel({ provider: "anthropic", id: "claude-opus-4-7" }),
    claudeOpus48: defineModel({ provider: "anthropic", id: "claude-opus-4-8" }),
  },
} as const;

export type ModelsTree = typeof models;
