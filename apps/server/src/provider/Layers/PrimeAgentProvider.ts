import {
  type ModelCapabilities,
  type PrimeAgentSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRIME_AGENT_PRESENTATION = {
  displayName: "Prime Agent",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PRIME_AGENT_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Prime Agent Default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

const THINKING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "thinking",
      label: "Thinking",
      options: [
        { value: "off", label: "Off" },
        { value: "minimal", label: "Minimal" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
      ],
    }),
  ],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const MODEL_SIZE_PATTERN = /^\d+(?:\.\d+)?[kmgt]?$/i;
const YES_NO_PATTERN = /^(?:yes|no)$/i;

export interface PrimeAgentModelListRow {
  readonly provider: string;
  readonly model: string;
  readonly context: string;
  readonly maxOut: string;
  readonly thinking: string;
  readonly images: string;
}

function normalizeTableLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/[|│┃]/g, " ")
    .trim();
}

function isModelListHeader(line: string): boolean {
  const tokens = line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/);
  return (
    tokens[0] === "provider" &&
    tokens[1] === "model" &&
    tokens.includes("context") &&
    tokens.includes("thinking") &&
    tokens.includes("images") &&
    (tokens.includes("maxout") || (tokens.includes("max") && tokens.includes("out")))
  );
}

export function parsePrimeAgentModelListRows(
  output: string,
): ReadonlyArray<PrimeAgentModelListRow> {
  const rows: PrimeAgentModelListRow[] = [];
  let sawHeader = false;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = normalizeTableLine(rawLine);
    if (!line) continue;
    if (isModelListHeader(line)) {
      sawHeader = true;
      continue;
    }
    if (!sawHeader || /^[-+━─═\s]+$/u.test(line)) continue;

    const columns = line.split(/\s+/);
    if (columns.length !== 6) continue;
    const [provider, model, context, maxOut, thinking, images] = columns;
    if (!provider || !model || !context || !maxOut || !thinking || !images) continue;
    if (
      !MODEL_SIZE_PATTERN.test(context) ||
      !MODEL_SIZE_PATTERN.test(maxOut) ||
      !YES_NO_PATTERN.test(thinking) ||
      !YES_NO_PATTERN.test(images)
    ) {
      continue;
    }
    rows.push({ provider, model, context, maxOut, thinking, images });
  }

  return rows;
}

export function parsePrimeAgentModelList(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const row of parsePrimeAgentModelListRows(output)) {
    const slug = `${row.provider}/${row.model}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: row.model,
      subProvider: row.provider,
      isCustom: false,
      capabilities:
        row.thinking.toLowerCase() === "yes" ? THINKING_CAPABILITIES : EMPTY_CAPABILITIES,
    });
  }

  return models;
}

export function parsePrimeAgentVersion(output: string): string | null {
  return parseGenericCliVersion(output);
}

function primeAgentModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [PRIME_AGENT_DEFAULT_MODEL, ...discoveredModels],
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialPrimeAgentProviderSnapshot(
  settings: PrimeAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = primeAgentModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: PRIME_AGENT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Prime Agent is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Prime Agent CLI availability...",
      },
    });
  });
}

const runPrimeAgentCommand = (
  settings: PrimeAgentSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "prime-agent";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkPrimeAgentProviderStatus = Effect.fn("checkPrimeAgentProviderStatus")(function* (
  settings: PrimeAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = primeAgentModelsFromSettings(settings.customModels);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Prime Agent is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPrimeAgentCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Prime Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `Prime Agent CLI executable \`${settings.binaryPath || "prime-agent"}\` was not found or is invalid.`
          : "Failed to execute Prime Agent CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent CLI timed out while running `prime-agent --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parsePrimeAgentVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Prime Agent CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent CLI is installed but failed to run.",
      },
    });
  }

  const discoveryResult = yield* runPrimeAgentCommand(settings, ["model", "list"], {
    ...environment,
    PI_OFFLINE: "1",
  }).pipe(Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(discoveryResult)) {
    yield* Effect.logWarning("Prime Agent model discovery failed.", {
      errorTag: discoveryResult.failure._tag,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent CLI is installed but model discovery failed.",
      },
    });
  }
  if (Option.isNone(discoveryResult.success)) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent model discovery timed out.",
      },
    });
  }

  const discoveryOutput = discoveryResult.success.value;
  if (discoveryOutput.code !== 0) {
    yield* Effect.logWarning("Prime Agent model discovery exited with a non-zero status.", {
      exitCode: discoveryOutput.code,
      stdoutLength: discoveryOutput.stdout.length,
      stderrLength: discoveryOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent CLI is installed but model discovery failed.",
      },
    });
  }

  const discoveredModels = parsePrimeAgentModelList(
    `${discoveryOutput.stdout}\n${discoveryOutput.stderr}`,
  );
  if (discoveredModels.length === 0) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent CLI did not report any available models.",
      },
    });
  }

  return buildServerProvider({
    presentation: PRIME_AGENT_PRESENTATION,
    enabled: true,
    checkedAt,
    models: primeAgentModelsFromSettings(settings.customModels, discoveredModels),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});
