import {
  type DevinSettings,
  type ModelCapabilities,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ProviderProbeError } from "../Errors.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { resolveDevinAcpBaseModelId } from "../acp/DevinAcpSupport.ts";
import { resolveEffectiveDevinBinary } from "../Drivers/DevinBinary.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Beta",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "adaptive",
    name: "Adaptive",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

interface DevinModelVariantJson {
  readonly model_uid?: unknown;
  readonly label?: unknown;
  readonly family_label?: unknown;
  readonly family_uid?: unknown;
  readonly cost_summary?: unknown;
  readonly max_context_tokens?: unknown;
}

interface DevinModelFamilyJson {
  readonly family_label?: unknown;
  readonly family_uid?: unknown;
  readonly slug?: unknown;
  readonly variants?: unknown;
}

const DEVIN_VARIANT_SUFFIXES = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "x-high",
  "max",
  "minimal",
  "thinking",
  "fast",
  "priority",
  "1m",
  "200k",
  "1000k",
  "1000000",
]);

const DEVIN_VARIANT_NAME_TOKENS = new Set([...DEVIN_VARIANT_SUFFIXES]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDevinVariantSuffixToken(token: string): boolean {
  return DEVIN_VARIANT_SUFFIXES.has(token.toLowerCase());
}

function isDevinVariantNameToken(token: string): boolean {
  return DEVIN_VARIANT_NAME_TOKENS.has(token.toLowerCase().replace(/[,]/g, ""));
}

function isDevinFamilyRecord(value: unknown): value is DevinModelFamilyJson {
  return isRecord(value) && Array.isArray((value as { variants?: unknown }).variants);
}

function buildDevinVariantDescription(variant: DevinModelVariantJson): string | undefined {
  const contextTokens =
    typeof variant.max_context_tokens === "number" ? variant.max_context_tokens : undefined;
  const costSummary = typeof variant.cost_summary === "string" ? variant.cost_summary : undefined;

  const parts: string[] = [];
  if (contextTokens) {
    parts.push(`${contextTokens >= 1000 ? `${contextTokens / 1000}K` : contextTokens} context`);
  }
  if (costSummary) {
    parts.push(costSummary);
  }

  return parts.length > 0 ? parts.join(", ") : undefined;
}

function buildDevinFamilyDescription(family: DevinModelFamilyJson): string | undefined {
  const variants = Array.isArray(family.variants)
    ? (family.variants as ReadonlyArray<DevinModelVariantJson>)
    : [];
  const first = variants[0];
  if (!first) {
    return undefined;
  }
  return buildDevinVariantDescription(first);
}

function normalizeDevinFamilyUidForModelUid(familyUid: string): string {
  return familyUid.replace(/\./g, "-").toLowerCase();
}

function resolveDevinVariantSuffix(familyUid: string, modelUid: string): string | undefined {
  const normalizedFamilyUid = normalizeDevinFamilyUidForModelUid(familyUid);
  const normalizedModelUid = modelUid.toLowerCase();
  if (normalizedModelUid === normalizedFamilyUid) {
    return "";
  }
  const prefix = `${normalizedFamilyUid}-`;
  if (!normalizedModelUid.startsWith(prefix)) {
    return undefined;
  }
  return normalizedModelUid.slice(prefix.length);
}

function normalizeLabelForComparison(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDevinVariantOptionLabel(
  variantLabel: string | undefined,
  familyName: string,
): string {
  const normalizedFamily = normalizeLabelForComparison(familyName);
  const label = variantLabel?.trim();
  if (!label) {
    return "Default";
  }

  const tokens = label.split(/\s+/);
  let consumedTokens = 0;
  let consumed = "";

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = consumed ? `${consumed} ${token}` : token;
    const normalizedNext = normalizeLabelForComparison(next);
    if (normalizedFamily.startsWith(normalizedNext)) {
      consumed = next;
      consumedTokens = i + 1;
    } else {
      break;
    }
  }

  const rest = tokens.slice(consumedTokens).join(" ");
  return rest.length > 0 ? rest : "Default";
}

function normalizeDevinReasoningValue(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/-+/g, "-");
}

function buildDevinReasoningDescriptor(
  familyName: string,
  familyUid: string,
  variants: ReadonlyArray<DevinModelVariantJson>,
): ProviderOptionDescriptor | undefined {
  const effectiveFamilyUid = familyUid;
  const options: Array<ProviderOptionChoice> = [];

  for (const variant of variants) {
    const modelUid = typeof variant.model_uid === "string" ? variant.model_uid.trim() : "";
    if (!modelUid) {
      continue;
    }
    const suffix = resolveDevinVariantSuffix(effectiveFamilyUid, modelUid);
    if (suffix === undefined && typeof variant.label !== "string") {
      continue;
    }
    const label = buildDevinVariantOptionLabel(
      typeof variant.label === "string" ? variant.label : undefined,
      familyName,
    );
    options.push({
      id: normalizeDevinReasoningValue(label),
      label,
      ...(options.length === 0 ? { isDefault: true } : {}),
    });
  }

  if (options.length <= 1) {
    return undefined;
  }

  return {
    id: "reasoning",
    label: "Reasoning",
    type: "select",
    options,
  };
}

function resolveDevinFamilyBaseSlug(rawSlug: string): string | undefined {
  if (!rawSlug) {
    return undefined;
  }

  const normalized = rawSlug.replace(/\./g, "-");

  const parts = normalized.split("-");
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!last || !isDevinVariantSuffixToken(last)) {
      break;
    }
    parts.pop();
  }
  return resolveDevinAcpBaseModelId(parts.join("-"));
}

function resolveDevinFamilyNameFromLabel(label: string): string {
  const tokens = label.split(/\s+/);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (!last || !isDevinVariantNameToken(last)) {
      break;
    }
    tokens.pop();

    // Drop a preceding "No" that was part of "No Thinking".
    const prev = tokens[tokens.length - 1];
    if (prev && /^No$/i.test(prev) && last.toLowerCase() === "thinking") {
      tokens.pop();
    }
  }

  const name = tokens.join(" ");
  return name.length > 0 ? name : label;
}

function slugifyFamilyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.]/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/-+/g, "-");
}

function isOpaqueDevinModelId(modelUid: string): boolean {
  return /^MODEL_/i.test(modelUid) || modelUid.includes("_");
}

function resolveDevinFamilySlugFromVariant(variant: DevinModelVariantJson): string | undefined {
  const familyUid = typeof variant.family_uid === "string" ? variant.family_uid.trim() : "";
  const modelUid = typeof variant.model_uid === "string" ? variant.model_uid.trim() : "";
  const slug =
    typeof (variant as { slug?: unknown }).slug === "string"
      ? ((variant as { slug?: unknown }).slug as string).trim()
      : "";

  // Prefer explicit family or model slugs; only strip variants from raw model_uids.
  const rawSlug = familyUid || slug || modelUid;
  if (!rawSlug) {
    return undefined;
  }

  if (familyUid || slug) {
    return resolveDevinFamilyBaseSlug(rawSlug);
  }

  const fromModelUid = resolveDevinFamilyBaseSlug(modelUid);
  const familyLabel = typeof variant.family_label === "string" ? variant.family_label.trim() : "";
  const label = typeof variant.label === "string" ? variant.label.trim() : "";

  const baseName = familyLabel || (label ? resolveDevinFamilyNameFromLabel(label) : undefined);
  const fromLabel = baseName ? resolveDevinAcpBaseModelId(slugifyFamilyName(baseName)) : undefined;

  // Opaque legacy ids like MODEL_PRIVATE_11 don't carry the family slug in the
  // model_uid. Some informative ids like claude-5-fable-medium also don't match
  // the canonical family slug (claude-fable-5), while labels like
  // "Claude Fable 5 Medium" do. In those cases, derive the slug from the label.
  if (
    fromLabel &&
    (fromModelUid === undefined || isOpaqueDevinModelId(modelUid) || fromLabel !== fromModelUid)
  ) {
    return fromLabel;
  }

  return fromModelUid;
}

function resolveDevinFamilyNameFromVariant(variant: DevinModelVariantJson): string | undefined {
  const familyLabel = typeof variant.family_label === "string" ? variant.family_label.trim() : "";
  if (familyLabel) {
    return familyLabel;
  }

  const label = typeof variant.label === "string" ? variant.label.trim() : "";
  if (!label) {
    return undefined;
  }

  return resolveDevinFamilyNameFromLabel(label);
}

export function deduplicateDevinProviderModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const groups = new Map<string, { readonly name: string; readonly model: ServerProviderModel }>();

  for (const model of models) {
    const baseName = resolveDevinFamilyNameFromLabel(model.name);
    const fromSlug = resolveDevinFamilyBaseSlug(model.slug);
    const fromName = resolveDevinAcpBaseModelId(slugifyFamilyName(baseName));

    const baseSlug =
      fromName &&
      (fromSlug === undefined || isOpaqueDevinModelId(model.slug) || fromName !== fromSlug)
        ? fromName
        : fromSlug;
    if (!baseSlug || groups.has(baseSlug)) {
      continue;
    }

    const deduplicated = { ...model, slug: baseSlug, name: baseName };
    groups.set(baseSlug, { name: baseName, model: deduplicated });
  }

  return Array.from(groups.values(), (group) => group.model).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function parseDevinModelFamilyList(
  families: ReadonlyArray<DevinModelFamilyJson>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];

  for (const family of families) {
    const familyRecord = family as DevinModelFamilyJson;
    const rawSlug =
      typeof familyRecord.slug === "string"
        ? familyRecord.slug
        : typeof familyRecord.family_uid === "string"
          ? familyRecord.family_uid
          : "";
    const familyName =
      typeof familyRecord.family_label === "string" ? familyRecord.family_label : "";

    if (!rawSlug) {
      continue;
    }

    const slug = resolveDevinAcpBaseModelId(rawSlug.replace(/\./g, "-"));
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);

    const variants = Array.isArray(familyRecord.variants)
      ? (familyRecord.variants as ReadonlyArray<DevinModelVariantJson>)
      : [];
    const description = buildDevinFamilyDescription(familyRecord);
    const resolvedFamilyName = familyName.trim() || slug;
    const reasoningDescriptor = buildDevinReasoningDescriptor(
      resolvedFamilyName,
      typeof familyRecord.family_uid === "string" ? familyRecord.family_uid : slug,
      variants,
    );

    models.push({
      slug,
      name: resolvedFamilyName,
      ...(description ? { description } : {}),
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: reasoningDescriptor ? [reasoningDescriptor] : [],
      }),
    });
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function parseDevinModelVariantList(
  variants: ReadonlyArray<DevinModelVariantJson>,
): ReadonlyArray<ServerProviderModel> {
  const groups = new Map<
    string,
    {
      readonly name: string;
      readonly familyUid: string | undefined;
      readonly variants: Array<DevinModelVariantJson>;
    }
  >();

  for (const variant of variants) {
    const variantRecord = variant as DevinModelVariantJson;
    const slug = resolveDevinFamilySlugFromVariant(variantRecord);
    if (!slug) {
      continue;
    }

    const existing = groups.get(slug);
    if (existing) {
      existing.variants.push(variantRecord);
      continue;
    }

    const name =
      resolveDevinFamilyNameFromVariant(variantRecord) || resolveDevinAcpBaseModelId(slug) || slug;
    const familyUid =
      typeof variantRecord.family_uid === "string" ? variantRecord.family_uid : undefined;
    groups.set(slug, { name, familyUid, variants: [variantRecord] });
  }

  const models: Array<ServerProviderModel> = [];
  for (const [slug, group] of groups) {
    const firstVariant = group.variants[0];
    const description = firstVariant ? buildDevinVariantDescription(firstVariant) : undefined;
    const familyUid = group.familyUid ?? slug;
    const reasoningDescriptor = buildDevinReasoningDescriptor(
      group.name,
      familyUid,
      group.variants,
    );

    models.push({
      slug,
      name: group.name,
      ...(description ? { description } : {}),
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: reasoningDescriptor ? [reasoningDescriptor] : [],
      }),
    });
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function parseDevinModelsJson(output: string): ReadonlyArray<ServerProviderModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }

  const familyRecords =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { families?: unknown }).families)
      ? (parsed as { families: ReadonlyArray<unknown> }).families
      : undefined;

  if (familyRecords && familyRecords.length > 0) {
    if (isDevinFamilyRecord(familyRecords[0])) {
      return parseDevinModelFamilyList(familyRecords as ReadonlyArray<DevinModelFamilyJson>);
    }
    return parseDevinModelVariantList(familyRecords as ReadonlyArray<DevinModelVariantJson>);
  }

  const topLevelArray = Array.isArray(parsed) ? parsed : undefined;
  if (topLevelArray && topLevelArray.length > 0) {
    if (isDevinFamilyRecord(topLevelArray[0])) {
      return parseDevinModelFamilyList(topLevelArray as ReadonlyArray<DevinModelFamilyJson>);
    }
    return parseDevinModelVariantList(topLevelArray as ReadonlyArray<DevinModelVariantJson>);
  }

  return [];
}

function parseDevinModelsText(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r/g, "");
    // Header lines group model families, e.g. "Claude Opus 4.7 (claude-opus-4.7)".
    // The lines below a header are reasoning/variant entries that we skip so the
    // picker only shows one model per family.
    const familyMatch = line.match(/^(.+?)\s+\(([\w\d-]+(?:[._-][\w\d-]+)*)\)\s*$/);
    if (!familyMatch) {
      continue;
    }
    const rawSlug = familyMatch[2] ?? "";
    const familyName = familyMatch[1] ?? "";
    const slug = resolveDevinAcpBaseModelId(rawSlug.replace(/\./g, "-"));
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: familyName.trim() || slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }

  return models;
}

export function parseDevinModelsList(output: string): ReadonlyArray<ServerProviderModel> {
  const jsonModels = parseDevinModelsJson(output);
  if (jsonModels.length > 0) {
    return jsonModels;
  }
  return parseDevinModelsText(output);
}

const runDevinModelsListCommand = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = yield* resolveEffectiveDevinBinary(devinSettings.binaryPath, environment);
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["models", "list", "--format", "json"],
      {
        env: environment,
      },
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const discoverDevinModelsViaModelsList = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const result = yield* runDevinModelsListCommand(devinSettings, environment);
    if (result.code !== 0) {
      return yield* new ProviderProbeError({
        provider: "devin",
        detail: `Devin models list failed with exit code ${result.code}.`,
      });
    }
    const stdoutModels = parseDevinModelsList(result.stdout);
    const models = stdoutModels.length > 0 ? stdoutModels : parseDevinModelsList(result.stderr);
    if (models.length === 0) {
      return yield* new ProviderProbeError({
        provider: "devin",
        detail: "Devin models list returned no parseable models.",
      });
    }
    return models;
  });

const runDevinVersionCommand = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = yield* resolveEffectiveDevinBinary(devinSettings.binaryPath, environment);
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinVersionCommand(devinSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const discoveredModels = yield* discoverDevinModelsViaModelsList(devinSettings, environment).pipe(
    Effect.timeout(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.tapError((cause) =>
      Effect.logWarning("Devin model discovery via `devin models list` failed", {
        errorTag: cause._tag,
      }),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProviderModel>),
  );
  const models =
    discoveredModels.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
