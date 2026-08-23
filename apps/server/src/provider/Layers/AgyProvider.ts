import {
  type AgySettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";

export const AGY_PRESENTATION = {
  displayName: "Antigravity",
  showInteractionModeToggle: true,
} as const;

const AGY_REASONING_EFFORTS = ["low", "medium", "high"] as const;
type AgyReasoningEffort = (typeof AGY_REASONING_EFFORTS)[number];

const agyModelCapabilities = (
  supportedEfforts: ReadonlyArray<AgyReasoningEffort>,
): ModelCapabilities => {
  const defaultEffort = supportedEfforts.includes("high")
    ? "high"
    : supportedEfforts.includes("medium")
      ? "medium"
      : supportedEfforts[0];
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: AGY_REASONING_EFFORTS.filter((effort) => supportedEfforts.includes(effort)).map(
          (effort) => ({
            value: effort,
            label: `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`,
            ...(effort === defaultEffort ? { isDefault: true } : {}),
          }),
        ),
      }),
    ],
  });
};

export const DEFAULT_AGY_MODEL_CAPABILITIES: ModelCapabilities =
  agyModelCapabilities(AGY_REASONING_EFFORTS);

const AGY_BUILT_IN_MODEL_VARIANTS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash (High)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash (Medium)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash (Low)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash (High)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.6-flash-medium",
    name: "Gemini 3.6 Flash (Medium)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.6-flash-low",
    name: "Gemini 3.6 Flash (Low)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.5-flash-high",
    name: "Gemini 3.5 Flash (High)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.5-flash-medium",
    name: "Gemini 3.5 Flash (Medium)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.5-flash-low",
    name: "Gemini 3.5 Flash (Low)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (Low)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    isCustom: false,
    capabilities: DEFAULT_AGY_MODEL_CAPABILITIES,
  },
];

export const AGY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = parseAgyModelsOutput(
  AGY_BUILT_IN_MODEL_VARIANTS.map(({ slug, name }) => `${slug}\t${name}`).join("\n"),
);

const DEFAULT_TIMEOUT_MS = 10_000;
const AGY_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const AGY_UNAUTHENTICATED_MESSAGE =
  "Antigravity CLI is not authenticated. Launch `agy` to sign in.";

function isAgyAuthenticationError(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`.toLowerCase();
  return (
    output.includes("please sign in") ||
    output.includes("authentication required") ||
    output.includes("not authenticated") ||
    output.includes("login required")
  );
}

export function agyModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = AGY_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  const groupedVariantSlugs = new Set<string>();
  for (const model of builtInModels) {
    const match = /^(.*)-(low|medium|high)$/.exec(model.slug);
    const reasoning = model.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoningEffort" && descriptor.type === "select",
    );
    if (!match?.[1] || !reasoning || reasoning.type !== "select") continue;
    for (const option of reasoning.options) {
      groupedVariantSlugs.add(`${match[1]}-${option.id}`);
    }
  }
  return providerModelsFromSettings(
    builtInModels,
    (customModels ?? []).filter((slug) => !groupedVariantSlugs.has(slug.trim())),
    DEFAULT_AGY_MODEL_CAPABILITIES,
  );
}

export function parseAgyModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const parsedModels = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "Fetching available models...")
    .flatMap((line) => {
      // agy 1.1.x prints the delimiter as the two literal characters `\\t`.
      // Accept a real tab as well for compatibility with scripts and future CLI versions.
      const [slug, ...nameParts] = line.split(/\\t|\t/);
      const normalizedSlug = slug?.trim();
      const name = nameParts.join("\t").trim();
      return normalizedSlug && name
        ? [
            {
              slug: normalizedSlug,
              name,
              isCustom: false,
              ...(!normalizedSlug.startsWith("gemini-") ? { isLegacy: true } : {}),
              capabilities: null,
            } satisfies ServerProviderModel,
          ]
        : [];
    });

  const grouped = new Map<
    string,
    {
      readonly name: string;
      readonly variants: Map<AgyReasoningEffort, ServerProviderModel>;
    }
  >();
  const orderedModels: Array<
    | { readonly type: "group"; readonly slug: string }
    | { readonly type: "standalone"; readonly model: ServerProviderModel }
  > = [];

  for (const model of parsedModels) {
    const slugMatch = /^(.*)-(low|medium|high)$/.exec(model.slug);
    const nameMatch = /^(.*) \((Low|Medium|High)\)$/.exec(model.name);
    if (!slugMatch || !nameMatch) {
      orderedModels.push({ type: "standalone", model });
      continue;
    }

    const baseSlug = slugMatch[1];
    const effort = slugMatch[2] as AgyReasoningEffort;
    const baseName = nameMatch[1];
    if (!baseSlug || !baseName || nameMatch[2]?.toLowerCase() !== effort) {
      orderedModels.push({ type: "standalone", model });
      continue;
    }

    const existing = grouped.get(baseSlug);
    const entry = existing ?? { name: baseName, variants: new Map() };
    if (!existing) {
      orderedModels.push({ type: "group", slug: baseSlug });
    }
    entry.variants.set(effort, model);
    grouped.set(baseSlug, entry);
  }

  return orderedModels.map((orderedModel) => {
    if (orderedModel.type === "standalone") return orderedModel.model;

    const group = grouped.get(orderedModel.slug);
    if (!group) {
      throw new Error(`Missing grouped Antigravity model: ${orderedModel.slug}`);
    }
    const { name, variants } = group;
    const efforts = AGY_REASONING_EFFORTS.filter((effort) => variants.has(effort));
    const defaultEffort = efforts.includes("high")
      ? "high"
      : efforts.includes("medium")
        ? "medium"
        : efforts[0];
    const defaultVariant = defaultEffort ? variants.get(defaultEffort) : undefined;
    return {
      slug: defaultVariant?.slug ?? [...variants.values()][0]!.slug,
      name,
      isCustom: false,
      ...(defaultVariant?.isLegacy ? { isLegacy: true } : {}),
      capabilities: agyModelCapabilities(efforts),
    } satisfies ServerProviderModel;
  });
}

export function buildInitialAgyProviderSnapshot(
  agySettings: AgySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = agyModelsFromSettings(agySettings.customModels);

    if (!agySettings.enabled) {
      return buildServerProvider({
        presentation: AGY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

const runAgyCommand = (
  agySettings: AgySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = agySettings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: environment,
    });
    const childCommand = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      stdin: "ignore",
    });
    return yield* spawnAndCollect(agySettings.binaryPath, childCommand);
  });

export const checkAgyProviderStatus = Effect.fn("checkAgyProviderStatus")(function* (
  agySettings: AgySettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = agyModelsFromSettings(agySettings.customModels);

  if (!agySettings.enabled) {
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Antigravity is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runAgyCommand(agySettings, ["--version"], resolvedEnvironment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Antigravity CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: agySettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Antigravity CLI (`agy`) was not found on PATH."
          : "Failed to execute Antigravity CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: agySettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Antigravity CLI version probe exited with non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: agySettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity CLI is installed but failed to run.",
      },
    });
  }

  const modelsProbe = yield* runAgyCommand(agySettings, ["models"], resolvedEnvironment).pipe(
    Effect.timeoutOption(AGY_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(modelsProbe)) {
    yield* Effect.logWarning("Antigravity model discovery failed", {
      errorTag: modelsProbe.failure._tag,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: agySettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Antigravity CLI is installed but model discovery failed. Check server logs for details.",
      },
    });
  }

  if (Option.isNone(modelsProbe.success)) {
    yield* Effect.logWarning(
      `Antigravity model discovery timed out after ${AGY_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: agySettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: `Antigravity CLI is installed but model discovery timed out after ${AGY_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  if (modelsProbe.success.value.code !== 0) {
    const authenticationRequired = isAgyAuthenticationError(
      modelsProbe.success.value.stdout,
      modelsProbe.success.value.stderr,
    );
    yield* Effect.logWarning("Antigravity model discovery exited with non-zero status", {
      exitCode: modelsProbe.success.value.code,
      stdoutLength: modelsProbe.success.value.stdout.length,
      stderrLength: modelsProbe.success.value.stderr.length,
      authenticationRequired,
    });
    return buildServerProvider({
      presentation: AGY_PRESENTATION,
      enabled: agySettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: authenticationRequired ? "unauthenticated" : "unknown" },
        message: authenticationRequired
          ? AGY_UNAUTHENTICATED_MESSAGE
          : "Antigravity CLI is installed but model discovery failed. Check server logs for details.",
      },
    });
  }

  const discoveredModels = parseAgyModelsOutput(modelsProbe.success.value.stdout);
  const models =
    discoveredModels.length > 0
      ? agyModelsFromSettings(agySettings.customModels, discoveredModels)
      : allModels;

  return buildServerProvider({
    presentation: AGY_PRESENTATION,
    enabled: agySettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});
