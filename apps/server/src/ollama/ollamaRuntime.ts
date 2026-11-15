import type { OllamaGpu, OllamaPullEvent } from "@t3tools/contracts";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** Accepts Ollama's own `OLLAMA_HOST` forms: `host:port`, `0.0.0.0`, or a full URL. */
export function resolveOllamaBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_OLLAMA_BASE_URL;
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  // A server bound to every interface is still reached through loopback.
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
  if (url.port === "") url.port = "11434";
  return `${url.protocol}//${url.host}`;
}

/** `host:port` for `OLLAMA_HOST` when Continuum starts its own server. */
export function ollamaListenAddress(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export interface OllamaReleaseAsset {
  readonly name: string;
  readonly format: "tar.zst" | "tgz" | "zip";
}

/** Official Ollama release archives that run without an installer or admin rights. */
export function ollamaReleaseAsset(platform: string, arch: string): OllamaReleaseAsset | null {
  if (platform === "linux" && arch === "x64") {
    return { name: "ollama-linux-amd64.tar.zst", format: "tar.zst" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { name: "ollama-linux-arm64.tar.zst", format: "tar.zst" };
  }
  if (platform === "win32" && arch === "x64") {
    return { name: "ollama-windows-amd64.zip", format: "zip" };
  }
  if (platform === "win32" && arch === "arm64") {
    return { name: "ollama-windows-arm64.zip", format: "zip" };
  }
  if (platform === "darwin") return { name: "ollama-darwin.tgz", format: "tgz" };
  return null;
}

/** Where each archive puts the `ollama` executable, relative to the extraction folder. */
export function ollamaExecutableCandidates(platform: string): ReadonlyArray<string> {
  return platform === "win32"
    ? ["ollama.exe", "bin/ollama.exe"]
    : ["bin/ollama", "ollama", "Ollama.app/Contents/Resources/ollama"];
}

/** Reads `sha256sum.txt` lines such as `<hex>  ./ollama-linux-amd64.tar.zst`. */
export function findSha256(sums: string, assetName: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/i.exec(line.trim());
    if (match && match[2] === assetName) return match[1]!.toLowerCase();
  }
  return null;
}

/** Parses `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmiGpus(output: string): ReadonlyArray<OllamaGpu> {
  const gpus: Array<OllamaGpu> = [];
  for (const line of output.split(/\r?\n/)) {
    const separator = line.lastIndexOf(",");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const mib = Number(line.slice(separator + 1).trim());
    if (name === "") continue;
    gpus.push({
      name,
      vendor: "nvidia",
      memoryBytes: Number.isFinite(mib) && mib > 0 ? mib * 1024 * 1024 : null,
    });
  }
  return gpus;
}

export interface OllamaPullProgress {
  readonly layers: Readonly<Record<string, { readonly total: number; readonly completed: number }>>;
}

export const EMPTY_PULL_PROGRESS: OllamaPullProgress = { layers: {} };

interface OllamaPullLine {
  readonly status?: string;
  readonly digest?: string;
  readonly total?: number;
  readonly completed?: number;
  readonly error?: string;
}

export type OllamaPullStep =
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "event";
      readonly progress: OllamaPullProgress;
      readonly event: OllamaPullEvent;
    };

/**
 * Folds one NDJSON line of `/api/pull` into overall progress. Ollama reports each layer on its
 * own, so the overall figure sums every layer seen so far.
 */
export function reduceOllamaPullLine(
  progress: OllamaPullProgress,
  raw: string,
): OllamaPullStep | null {
  const text = raw.trim();
  if (text === "") return null;
  let line: OllamaPullLine;
  try {
    line = JSON.parse(text) as OllamaPullLine;
  } catch {
    return null;
  }
  if (typeof line.error === "string") return { type: "error", message: line.error };
  let next = progress;
  if (typeof line.digest === "string" && typeof line.total === "number") {
    next = {
      layers: {
        ...progress.layers,
        [line.digest]: { total: line.total, completed: line.completed ?? 0 },
      },
    };
  }
  const layers = Object.values(next.layers);
  const totalBytes = layers.reduce((sum, layer) => sum + layer.total, 0);
  const completedBytes = layers.reduce(
    (sum, layer) => sum + Math.min(layer.completed, layer.total),
    0,
  );
  return {
    type: "event",
    progress: next,
    event: {
      type: "progress",
      status: line.status ?? "",
      completedBytes: layers.length === 0 ? null : completedBytes,
      totalBytes: layers.length === 0 ? null : totalBytes,
    },
  };
}

/**
 * Ollama loads models with a 4,096-token context unless told otherwise, and silently drops
 * the start of a longer prompt. An agent's instructions and tool definitions alone are about
 * 16,000 tokens, so agents run a variant of each model that asks for this much.
 */
export const OLLAMA_AGENT_CONTEXT_TOKENS = 32_768;
const AGENT_VARIANT_PREFIX = "continuum/";

export function isOllamaAgentVariant(name: string): boolean {
  return name.startsWith(AGENT_VARIANT_PREFIX);
}

/** The variant shares the base model's weights; only its parameters differ. */
export function ollamaAgentVariantName(baseName: string): string {
  return `${AGENT_VARIANT_PREFIX}${baseName.replaceAll(/[/:]/g, "-")}`;
}

export function ollamaAgentContextTokens(trainedContext: number | null): number {
  return trainedContext === null
    ? OLLAMA_AGENT_CONTEXT_TOKENS
    : Math.min(trainedContext, OLLAMA_AGENT_CONTEXT_TOKENS);
}
