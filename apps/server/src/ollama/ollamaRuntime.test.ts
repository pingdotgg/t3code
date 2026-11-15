import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PULL_PROGRESS,
  findSha256,
  isOllamaAgentVariant,
  ollamaAgentContextTokens,
  ollamaAgentVariantName,
  ollamaListenAddress,
  ollamaReleaseAsset,
  parseNvidiaSmiGpus,
  reduceOllamaPullLine,
  resolveOllamaBaseUrl,
  type OllamaPullProgress,
} from "./ollamaRuntime.ts";

describe("resolveOllamaBaseUrl", () => {
  it("reads OLLAMA_HOST the way Ollama does", () => {
    expect(resolveOllamaBaseUrl(undefined)).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaBaseUrl("0.0.0.0")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaBaseUrl("127.0.0.1:11500")).toBe("http://127.0.0.1:11500");
    expect(resolveOllamaBaseUrl("https://gpu-box.local:8443/")).toBe("https://gpu-box.local:8443");
    expect(resolveOllamaBaseUrl("not a url ::")).toBe("http://127.0.0.1:11434");
    expect(ollamaListenAddress("http://127.0.0.1:11500")).toBe("127.0.0.1:11500");
  });
});

describe("ollamaReleaseAsset", () => {
  it("picks the official archive for each supported desktop platform", () => {
    expect(ollamaReleaseAsset("linux", "x64")?.name).toBe("ollama-linux-amd64.tar.zst");
    expect(ollamaReleaseAsset("linux", "arm64")?.name).toBe("ollama-linux-arm64.tar.zst");
    expect(ollamaReleaseAsset("win32", "x64")?.format).toBe("zip");
    expect(ollamaReleaseAsset("darwin", "arm64")?.name).toBe("ollama-darwin.tgz");
    expect(ollamaReleaseAsset("freebsd", "x64")).toBeNull();
  });

  it("finds the asset's checksum in sha256sum.txt", () => {
    const sums = [
      `${"a".repeat(64)}  ./ollama-darwin.tgz`,
      `${"B".repeat(64)}  ./ollama-linux-amd64.tar.zst`,
    ].join("\n");
    expect(findSha256(sums, "ollama-linux-amd64.tar.zst")).toBe("b".repeat(64));
    expect(findSha256(sums, "ollama-windows-amd64.zip")).toBeNull();
  });
});

describe("parseNvidiaSmiGpus", () => {
  it("reads names with commas and memory in MiB", () => {
    expect(parseNvidiaSmiGpus("NVIDIA GeForce RTX 4070, 12282\nTesla T4, 15360\n")).toEqual([
      { name: "NVIDIA GeForce RTX 4070", vendor: "nvidia", memoryBytes: 12282 * 1024 * 1024 },
      { name: "Tesla T4", vendor: "nvidia", memoryBytes: 15360 * 1024 * 1024 },
    ]);
    expect(parseNvidiaSmiGpus("")).toEqual([]);
  });
});

describe("reduceOllamaPullLine", () => {
  const fold = (lines: ReadonlyArray<string>) => {
    let progress: OllamaPullProgress = EMPTY_PULL_PROGRESS;
    const events = [];
    for (const line of lines) {
      const step = reduceOllamaPullLine(progress, line);
      if (step?.type === "event") {
        progress = step.progress;
        events.push(step.event);
      } else if (step?.type === "error") {
        events.push(step);
      }
    }
    return events;
  };

  it("sums progress across every layer Ollama reports", () => {
    const events = fold([
      '{"status":"pulling manifest"}',
      '{"status":"pulling a1","digest":"a1","total":1000,"completed":250}',
      '{"status":"pulling b2","digest":"b2","total":100,"completed":100}',
      '{"status":"pulling a1","digest":"a1","total":1000,"completed":1000}',
      "",
      '{"status":"success"}',
    ]);
    expect(events[0]).toEqual({
      type: "progress",
      status: "pulling manifest",
      completedBytes: null,
      totalBytes: null,
    });
    expect(events.at(-2)).toEqual({
      type: "progress",
      status: "pulling a1",
      completedBytes: 1100,
      totalBytes: 1100,
    });
    expect(events.at(-1)).toMatchObject({ status: "success", completedBytes: 1100 });
  });

  it("surfaces Ollama's error message", () => {
    expect(fold(['{"error":"pull model manifest: file does not exist"}'])).toEqual([
      { type: "error", message: "pull model manifest: file does not exist" },
    ]);
  });
});

describe("agent variants", () => {
  it("names a variant Ollama accepts and never asks for more context than the model has", () => {
    expect(ollamaAgentVariantName("qwen3:8b")).toBe("continuum/qwen3-8b");
    expect(ollamaAgentVariantName("hf.co/user/repo:Q4_K_M")).toBe(
      "continuum/hf.co-user-repo-Q4_K_M",
    );
    expect(isOllamaAgentVariant("continuum/qwen3-8b:latest")).toBe(true);
    expect(isOllamaAgentVariant("qwen3:8b")).toBe(false);
    expect(ollamaAgentContextTokens(40_960)).toBe(32_768);
    expect(ollamaAgentContextTokens(8_192)).toBe(8_192);
    expect(ollamaAgentContextTokens(null)).toBe(32_768);
  });
});
