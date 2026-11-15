import * as Schema from "effect/Schema";

/**
 * Local models through Ollama. The server talks to an Ollama HTTP API (one it
 * installed and runs itself, or one already running on the machine) and exposes
 * tool-capable models to agents through a Codex instance with `model_provider=ollama`.
 */

/** Ollama model references such as `qwen3-coder:30b` or `library/llama3.1:8b`. */
export const OllamaModelName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,127}(?::[A-Za-z0-9._-]{1,127})?$/),
);
export type OllamaModelName = typeof OllamaModelName.Type;

export const OllamaRuntimeKind = Schema.Literals(["managed", "external", "none"]);
export type OllamaRuntimeKind = typeof OllamaRuntimeKind.Type;

export const OllamaStatus = Schema.Struct({
  baseUrl: Schema.String,
  reachable: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  /** `managed`: Continuum installed and runs it. `external`: another Ollama answers. */
  runtime: OllamaRuntimeKind,
  managedInstalled: Schema.Boolean,
  managedVersion: Schema.NullOr(Schema.String),
  /** False where no official Ollama build exists for this OS and architecture. */
  canInstall: Schema.Boolean,
  agentIntegrationEnabled: Schema.Boolean,
});
export type OllamaStatus = typeof OllamaStatus.Type;

export const OllamaGpuVendor = Schema.Literals(["nvidia", "amd", "apple", "intel", "unknown"]);
export type OllamaGpuVendor = typeof OllamaGpuVendor.Type;

export const OllamaGpu = Schema.Struct({
  name: Schema.String,
  vendor: OllamaGpuVendor,
  memoryBytes: Schema.NullOr(Schema.Number),
});
export type OllamaGpu = typeof OllamaGpu.Type;

export const OllamaHardware = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  totalMemoryBytes: Schema.Number,
  freeMemoryBytes: Schema.Number,
  cpuCount: Schema.Number,
  cpuModel: Schema.String,
  gpus: Schema.Array(OllamaGpu),
  /** Apple silicon shares system memory with the GPU. */
  unifiedMemory: Schema.Boolean,
});
export type OllamaHardware = typeof OllamaHardware.Type;

export const OllamaInstalledModel = Schema.Struct({
  name: Schema.String,
  sizeBytes: Schema.Number,
  parameterSize: Schema.NullOr(Schema.String),
  quantization: Schema.NullOr(Schema.String),
  family: Schema.NullOr(Schema.String),
  contextLength: Schema.NullOr(Schema.Number),
  /** As Ollama reports them, such as `completion`, `tools`, `thinking`, `vision`. */
  capabilities: Schema.Array(Schema.String),
  modifiedAt: Schema.NullOr(Schema.String),
});
export type OllamaInstalledModel = typeof OllamaInstalledModel.Type;

export const OllamaOverview = Schema.Struct({
  status: OllamaStatus,
  hardware: OllamaHardware,
  models: Schema.Array(OllamaInstalledModel),
});
export type OllamaOverview = typeof OllamaOverview.Type;

export const OllamaInstallStage = Schema.Literals(["downloading", "extracting", "starting"]);
export type OllamaInstallStage = typeof OllamaInstallStage.Type;

export const OllamaInstallEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: OllamaInstallStage,
    completedBytes: Schema.NullOr(Schema.Number),
    totalBytes: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("complete"), status: OllamaStatus }),
]);
export type OllamaInstallEvent = typeof OllamaInstallEvent.Type;

export const OllamaPullInput = Schema.Struct({ model: OllamaModelName });
export type OllamaPullInput = typeof OllamaPullInput.Type;

export const OllamaPullEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    status: Schema.String,
    completedBytes: Schema.NullOr(Schema.Number),
    totalBytes: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("complete"), model: Schema.String }),
]);
export type OllamaPullEvent = typeof OllamaPullEvent.Type;

export const OllamaDeleteModelInput = Schema.Struct({ model: OllamaModelName });
export type OllamaDeleteModelInput = typeof OllamaDeleteModelInput.Type;

export const OllamaSetAgentIntegrationInput = Schema.Struct({ enabled: Schema.Boolean });
export type OllamaSetAgentIntegrationInput = typeof OllamaSetAgentIntegrationInput.Type;

/** The provider instance that runs local models with Codex's agent tools. */
export const OLLAMA_AGENT_INSTANCE_ID = "ollama-local";

export class OllamaError extends Schema.TaggedError<OllamaError>()("OllamaError", {
  message: Schema.String,
}) {}
