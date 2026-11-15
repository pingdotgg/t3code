import type { OllamaHardware } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  OLLAMA_MODEL_CATALOG,
  assessOllamaModelFit,
  ollamaModelSupportsAgents,
} from "./ollamaCatalog.ts";

const GB = 1_000_000_000;

const pc = (memoryGb: number, gpuGb: number | null): OllamaHardware => ({
  platform: "linux",
  arch: "x64",
  totalMemoryBytes: memoryGb * GB,
  freeMemoryBytes: memoryGb * GB,
  cpuCount: 8,
  cpuModel: "test",
  gpus: gpuGb === null ? [] : [{ name: "GPU", vendor: "nvidia", memoryBytes: gpuGb * GB }],
  unifiedMemory: false,
});

describe("assessOllamaModelFit", () => {
  it("prefers a GPU that holds the whole model", () => {
    expect(assessOllamaModelFit(4.7 * GB, pc(16, 12)).fit).toBe("gpu");
  });

  it("splits a model across GPU and RAM when the GPU alone is too small", () => {
    expect(assessOllamaModelFit(19 * GB, pc(32, 12)).fit).toBe("partial");
  });

  it("falls back to the CPU without a GPU", () => {
    expect(assessOllamaModelFit(4.7 * GB, pc(16, null)).fit).toBe("cpu");
  });

  it("refuses models that do not fit in memory at all", () => {
    const result = assessOllamaModelFit(65 * GB, pc(16, 8));
    expect(result.fit).toBe("insufficient");
    expect(result.summary).toContain("16 GB");
  });

  it("uses three quarters of unified memory on Apple silicon", () => {
    const mac = { ...pc(32, null), platform: "darwin", arch: "arm64", unifiedMemory: true };
    expect(assessOllamaModelFit(14 * GB, mac).fit).toBe("gpu");
    expect(assessOllamaModelFit(65 * GB, mac).fit).toBe("insufficient");
  });
});

describe("catalog", () => {
  it("lists unique, pullable model tags", () => {
    const names = OLLAMA_MODEL_CATALOG.map((model) => model.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9.-]+:[a-z0-9.]+$/);
  });

  it("offers a model to agents only when it reports tool calling", () => {
    expect(ollamaModelSupportsAgents({ capabilities: ["completion", "tools"] })).toBe(true);
    expect(ollamaModelSupportsAgents({ capabilities: ["completion"] })).toBe(false);
  });
});
