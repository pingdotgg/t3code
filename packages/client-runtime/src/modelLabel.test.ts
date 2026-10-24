import { describe, expect, it } from "vite-plus/test";

import { composerModelLabel } from "./modelLabel.ts";

describe("composerModelLabel", () => {
  it.each([
    ["Nemotron 3.5 Super VL Free", "Nemotron 3.5 Super"],
    ["Ox Alpha Free (Unlimited)", "Ox Alpha"],
    ["DeepSeek V4 Flash Vision Exp", "DeepSeek V4 Flash"],
    ["LongCat 2.5 Preview Free", "LongCat 2.5"],
    ["4 Argon Contributor", "4 Argon Contributor"],
    ["Nemotron 3 Nano Omni (free)", "Nemotron 3 Nano Omni"],
    ["Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)", "Nano Banana 2 Lite"],
    ["GPT-OSS (Vertex AI (OpenAI-compatible))", "GPT-OSS"],
    ["NVIDIA: Nemotron 3.5 Lightning Free", "Nemotron 3.5 Lightning"],
    ["3.1 Pro Preview Custom Tools", "3.1 Pro"],
    ["Qwen3 235B-A22B Thinking 2507", "Qwen3 235B"],
    ["Qwen3-Next 80B-A3B (Thinking)", "Qwen3-Next 80B"],
    ["Nemotron 3 Nano Omni 30B A3B Reasoning", "Nemotron 3 Nano Omni"],
    ["Qwen3 Coder 480B A35B Instruct Turbo", "Qwen3 Coder"],
    ["Llama 4 Maverick 17B Instruct (US)", "Llama 4 Maverick"],
    ["DeepSeek V4.1 Flash 1017 Spot", "DeepSeek V4.1 Flash"],
    ["GLM Flash Latest (GLM 5.3 Flash)", "GLM Flash"],
    ["Grok 4.20 (Non-Reasoning)", "Grok 4.20"],
    ["4.1 Fast Non-Reasoning", "4.1 Fast"],
    ["3.1 Flash Image Preview (Nano Banana 2)", "3.1 Flash Image"],
    ["Gemini 2.5 Flash Preview (09/2025) – Thinking", "Gemini 2.5 Flash"],
    ["Opus 5.5", "Opus 5.5"],
    ["GPT-5.5", "GPT-5.5"],
    ["Grok 4", "Grok 4"],
    ["Thinking", "Thinking"],
    ["(Preview)", "(Preview)"],
  ])("labels %s as %s", (name, label) => {
    expect(composerModelLabel(name)).toBe(label);
  });
});
