import type { OllamaInstalledModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  OLLAMA_CODEX_LAUNCH_ARGS,
  buildOllamaAgentInstance,
  ollamaAgentCodexBinaryPath,
  ollamaAgentInstanceIsCurrent,
} from "./OllamaAgentInstance.ts";
import { codexLocalModelProvider } from "../provider/codexLaunchArgs.ts";

const model = (name: string, capabilities: ReadonlyArray<string>): OllamaInstalledModel => ({
  name,
  sizeBytes: 1,
  parameterSize: null,
  quantization: null,
  family: null,
  contextLength: null,
  capabilities,
  modifiedAt: null,
});

describe("buildOllamaAgentInstance", () => {
  const models = [
    model("qwen3:8b", ["completion", "tools"]),
    model("gemma3:4b", ["completion", "vision"]),
    model("gpt-oss:20b", ["completion", "tools", "thinking"]),
  ];

  it("offers the large-context variant of each tool-calling model to a Codex agent", () => {
    const instance = buildOllamaAgentInstance({
      baseUrl: "http://127.0.0.1:11434",
      codexHome: "/home/u/.continuum/codex-ollama",
      codexBinaryPath: "/home/u/.continuum/tools/codex/codex",
      models,
    });
    expect(instance.driver).toBe("codex");
    expect(instance.environment).toEqual([]);
    expect(instance.config).toEqual({
      binaryPath: "/home/u/.continuum/tools/codex/codex",
      launchArgs: OLLAMA_CODEX_LAUNCH_ARGS,
      homePath: "/home/u/.continuum/codex-ollama",
      customModels: [
        { slug: "continuum/gpt-oss-20b", name: "gpt-oss:20b (local)" },
        { slug: "continuum/qwen3-8b", name: "qwen3:8b (local)" },
      ],
    });
    // The provider hides OpenAI's catalog for exactly these launch arguments.
    expect(codexLocalModelProvider(OLLAMA_CODEX_LAUNCH_ARGS)).toBe("ollama");
    expect(ollamaAgentCodexBinaryPath(instance)).toBe("/home/u/.continuum/tools/codex/codex");
  });

  it("points Codex at a non-default Ollama address", () => {
    const instance = buildOllamaAgentInstance({
      baseUrl: "http://gpu-box:11434",
      codexHome: "/h",
      codexBinaryPath: "",
      models: [],
    });
    expect(instance.environment).toEqual([
      { name: "CODEX_OSS_BASE_URL", value: "http://gpu-box:11434/v1", sensitive: false },
    ]);
    expect(instance.config).not.toHaveProperty("binaryPath");
  });

  it("rewrites the instance only when the model list changes", () => {
    const input = { baseUrl: "http://127.0.0.1:11434", codexHome: "/h", codexBinaryPath: "" };
    const current = buildOllamaAgentInstance({ ...input, models });
    expect(
      ollamaAgentInstanceIsCurrent(current, buildOllamaAgentInstance({ ...input, models })),
    ).toBe(true);
    expect(
      ollamaAgentInstanceIsCurrent(current, buildOllamaAgentInstance({ ...input, models: [] })),
    ).toBe(false);
    expect(ollamaAgentInstanceIsCurrent(undefined, current)).toBe(false);
  });
});
