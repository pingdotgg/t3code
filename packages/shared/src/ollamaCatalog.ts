import type { OllamaHardware, OllamaInstalledModel } from "@t3tools/contracts";

export type OllamaCatalogTag = "coding" | "reasoning" | "general" | "small" | "large";

export interface OllamaCatalogModel {
  /** The tag passed to `ollama pull`. */
  readonly name: string;
  readonly title: string;
  readonly publisher: string;
  readonly description: string;
  readonly parameters: string;
  /** Approximate download size of the default quantization; the real size shows while it downloads. */
  readonly downloadBytes: number;
  readonly contextTokens: number;
  readonly tags: ReadonlyArray<OllamaCatalogTag>;
}

const GB = 1_000_000_000;

/**
 * Curated models that support tool calling in Ollama, which agents need to run commands and
 * edit files. Any other library model can still be pulled by name.
 */
export const OLLAMA_MODEL_CATALOG: ReadonlyArray<OllamaCatalogModel> = [
  {
    name: "qwen3-coder:30b",
    title: "Qwen3 Coder 30B",
    publisher: "Alibaba Qwen",
    description:
      "Mixture-of-experts coding model built for agentic work: tool use, repository edits, and long files. Only about 3B parameters are active per token, so it runs faster than its size suggests.",
    parameters: "30B (3.3B active)",
    downloadBytes: 19 * GB,
    contextTokens: 262_144,
    tags: ["coding", "large"],
  },
  {
    name: "gpt-oss:20b",
    title: "gpt-oss 20B",
    publisher: "OpenAI",
    description:
      "OpenAI's open-weight reasoning model with native tool calling. A strong general agent that fits a 16 GB GPU or Apple silicon Mac.",
    parameters: "21B (3.6B active)",
    downloadBytes: 14 * GB,
    contextTokens: 131_072,
    tags: ["reasoning", "coding"],
  },
  {
    name: "devstral:24b",
    title: "Devstral 24B",
    publisher: "Mistral AI",
    description:
      "Agentic coding model trained to explore codebases, edit several files, and use tools. Good on a 24 GB GPU or a 32 GB Mac.",
    parameters: "24B",
    downloadBytes: 14 * GB,
    contextTokens: 131_072,
    tags: ["coding"],
  },
  {
    name: "qwen2.5-coder:7b",
    title: "Qwen2.5 Coder 7B",
    publisher: "Alibaba Qwen",
    description:
      "Compact coding model with tool support. A practical choice for laptops and 8 GB GPUs.",
    parameters: "7.6B",
    downloadBytes: 4.7 * GB,
    contextTokens: 32_768,
    tags: ["coding", "small"],
  },
  {
    name: "qwen2.5-coder:14b",
    title: "Qwen2.5 Coder 14B",
    publisher: "Alibaba Qwen",
    description: "Mid-size coding model with tool support for 12-16 GB GPUs.",
    parameters: "14.8B",
    downloadBytes: 9 * GB,
    contextTokens: 32_768,
    tags: ["coding"],
  },
  {
    name: "qwen3:8b",
    title: "Qwen3 8B",
    publisher: "Alibaba Qwen",
    description:
      "General model with tool calling and an optional thinking mode. Handles everyday coding questions and small edits.",
    parameters: "8.2B",
    downloadBytes: 5.2 * GB,
    contextTokens: 40_960,
    tags: ["general", "reasoning", "small"],
  },
  {
    name: "qwen3:14b",
    title: "Qwen3 14B",
    publisher: "Alibaba Qwen",
    description: "Larger general model with tool calling and thinking mode.",
    parameters: "14.8B",
    downloadBytes: 9.3 * GB,
    contextTokens: 40_960,
    tags: ["general", "reasoning"],
  },
  {
    name: "llama3.1:8b",
    title: "Llama 3.1 8B",
    publisher: "Meta",
    description: "Widely used general model with tool calling. Runs on most recent laptops.",
    parameters: "8B",
    downloadBytes: 4.9 * GB,
    contextTokens: 131_072,
    tags: ["general", "small"],
  },
  {
    name: "qwen3:1.7b",
    title: "Qwen3 1.7B",
    publisher: "Alibaba Qwen",
    description:
      "Very small model with tool calling, for trying local agents on modest hardware. Expect simple tasks only.",
    parameters: "2B",
    downloadBytes: 1.4 * GB,
    contextTokens: 40_960,
    tags: ["general", "small"],
  },
  {
    name: "gpt-oss:120b",
    title: "gpt-oss 120B",
    publisher: "OpenAI",
    description:
      "OpenAI's large open-weight reasoning model. Needs about 80 GB of GPU memory or a high-memory Mac.",
    parameters: "117B (5.1B active)",
    downloadBytes: 65 * GB,
    contextTokens: 131_072,
    tags: ["reasoning", "coding", "large"],
  },
];

/** Memory a model needs to load: its weights plus the 32K-token context agents run with. */
function estimateOllamaMemoryBytes(downloadBytes: number): number {
  return Math.ceil(downloadBytes * 1.15 + 3 * GB);
}

export type OllamaFit = "gpu" | "partial" | "cpu" | "insufficient";

export interface OllamaFitAssessment {
  readonly fit: OllamaFit;
  readonly requiredBytes: number;
  readonly summary: string;
}

const formatGb = (bytes: number) => `${Math.round((bytes / GB) * 10) / 10} GB`;

/** Whether this machine can run a model of the given size, and roughly how well. */
export function assessOllamaModelFit(
  downloadBytes: number,
  hardware: OllamaHardware,
): OllamaFitAssessment {
  const requiredBytes = estimateOllamaMemoryBytes(downloadBytes);
  const required = formatGb(requiredBytes);
  if (hardware.unifiedMemory) {
    // macOS lets the GPU use roughly three quarters of unified memory by default.
    if (hardware.totalMemoryBytes * 0.75 >= requiredBytes) {
      return { fit: "gpu", requiredBytes, summary: `Runs on the GPU (needs about ${required}).` };
    }
    return hardware.totalMemoryBytes >= requiredBytes * 1.1
      ? {
          fit: "cpu",
          requiredBytes,
          summary: `Tight fit; may run slowly (needs about ${required}).`,
        }
      : {
          fit: "insufficient",
          requiredBytes,
          summary: `Needs about ${required}; this Mac has ${formatGb(hardware.totalMemoryBytes)}.`,
        };
  }
  const largestGpu = Math.max(0, ...hardware.gpus.map((gpu) => gpu.memoryBytes ?? 0));
  if (largestGpu >= requiredBytes) {
    return {
      fit: "gpu",
      requiredBytes,
      summary: `Runs fully on your GPU (needs about ${required}).`,
    };
  }
  const totalUsable = hardware.totalMemoryBytes + largestGpu;
  if (largestGpu > 0 && totalUsable >= requiredBytes * 1.1) {
    return {
      fit: "partial",
      requiredBytes,
      summary: `Splits between GPU and CPU; usable but slower (needs about ${required}).`,
    };
  }
  if (hardware.totalMemoryBytes >= requiredBytes * 1.1) {
    return {
      fit: "cpu",
      requiredBytes,
      summary: `Runs on the CPU; expect slow responses (needs about ${required}).`,
    };
  }
  return {
    fit: "insufficient",
    requiredBytes,
    summary: `Needs about ${required} of memory; this computer has ${formatGb(hardware.totalMemoryBytes)}.`,
  };
}

/** Agents need tool calling to run commands and edit files. */
export function ollamaModelSupportsAgents(
  model: Pick<OllamaInstalledModel, "capabilities">,
): boolean {
  return model.capabilities.includes("tools");
}
