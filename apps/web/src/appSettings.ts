import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import { type ProviderKind, type ProviderServiceTier } from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const APP_DEFAULT_MODEL_AUTO = "auto" as const;
export const APP_SERVICE_TIER_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use Codex defaults without forcing a service tier.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Request the fast service tier when the model supports it.",
  },
  {
    value: "flex",
    label: "Flex",
    description: "Request the flex service tier when the model supports it.",
  },
] as const;
export type AppServiceTier = (typeof APP_SERVICE_TIER_OPTIONS)[number]["value"];
const AppServiceTierSchema = Schema.Literals(["auto", "fast", "flex"]);
const MODELS_WITH_FAST_SUPPORT = new Set(["gpt-5.4"]);
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
};

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  codexServiceTier: AppServiceTierSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("auto")),
  ),
  defaultCodexModel: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_MODEL_LENGTH)).pipe(
    Schema.withConstructorDefault(() => Option.some(APP_DEFAULT_MODEL_AUTO)),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}
export interface AppProjectModelHistoryEntry {
  projectId: string;
  model: string;
  createdAt: string;
}

export function resolveAppServiceTier(serviceTier: AppServiceTier): ProviderServiceTier | null {
  return serviceTier === "auto" ? null : serviceTier;
}

export function shouldShowFastTierIcon(
  model: string | null | undefined,
  serviceTier: AppServiceTier,
): boolean {
  const normalizedModel = normalizeModelSlug(model);
  return (
    resolveAppServiceTier(serviceTier) === "fast" &&
    normalizedModel !== null &&
    MODELS_WITH_FAST_SUPPORT.has(normalizedModel)
  );
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      normalized.toLowerCase() === APP_DEFAULT_MODEL_AUTO ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function normalizeAppDefaultModelSetting(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return APP_DEFAULT_MODEL_AUTO;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return APP_DEFAULT_MODEL_AUTO;
  }
  return trimmed.toLowerCase() === APP_DEFAULT_MODEL_AUTO ? APP_DEFAULT_MODEL_AUTO : trimmed;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const customCodexModels = normalizeCustomModelSlugs(settings.customCodexModels, "codex");
  const normalizedDefaultCodexModel = normalizeAppDefaultModelSetting(settings.defaultCodexModel);
  return {
    ...settings,
    customCodexModels,
    defaultCodexModel:
      normalizedDefaultCodexModel === APP_DEFAULT_MODEL_AUTO
        ? APP_DEFAULT_MODEL_AUTO
        : resolveAppModelSelection("codex", customCodexModels, normalizedDefaultCodexModel),
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function resolveProjectDefaultModelForNewThread(input: {
  projectId: string;
  projectModel: string | null | undefined;
  threads: ReadonlyArray<AppProjectModelHistoryEntry>;
  defaultModelSetting: string | null | undefined;
  customModels: readonly string[];
  provider?: ProviderKind;
}): string {
  const provider = input.provider ?? "codex";
  const defaultModelSetting = normalizeAppDefaultModelSetting(input.defaultModelSetting);
  if (defaultModelSetting !== APP_DEFAULT_MODEL_AUTO) {
    return resolveAppModelSelection(provider, input.customModels, defaultModelSetting);
  }

  const usageByModel = new Map<string, { count: number; latestCreatedAtMs: number }>();
  for (const thread of input.threads) {
    if (thread.projectId !== input.projectId) {
      continue;
    }
    const normalizedModel = normalizeModelSlug(thread.model, provider);
    if (!normalizedModel) {
      continue;
    }
    const createdAtMsRaw = Date.parse(thread.createdAt);
    const createdAtMs = Number.isFinite(createdAtMsRaw) ? createdAtMsRaw : Number.NEGATIVE_INFINITY;
    const existing = usageByModel.get(normalizedModel);
    if (!existing) {
      usageByModel.set(normalizedModel, {
        count: 1,
        latestCreatedAtMs: createdAtMs,
      });
      continue;
    }
    existing.count += 1;
    if (createdAtMs > existing.latestCreatedAtMs) {
      existing.latestCreatedAtMs = createdAtMs;
    }
  }

  let mostUsedModel: string | null = null;
  let mostUsedCount = -1;
  let mostRecentUseMs = Number.NEGATIVE_INFINITY;

  for (const [model, usage] of usageByModel.entries()) {
    if (
      usage.count > mostUsedCount ||
      (usage.count === mostUsedCount &&
        (usage.latestCreatedAtMs > mostRecentUseMs ||
          (usage.latestCreatedAtMs === mostRecentUseMs &&
            (mostUsedModel === null || model.localeCompare(mostUsedModel) < 0))))
    ) {
      mostUsedModel = model;
      mostUsedCount = usage.count;
      mostRecentUseMs = usage.latestCreatedAtMs;
    }
  }

  if (mostUsedModel) {
    return resolveAppModelSelection(provider, input.customModels, mostUsedModel);
  }

  return resolveAppModelSelection(
    provider,
    input.customModels,
    input.projectModel ?? getDefaultModel(provider),
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    return normalizeAppSettings(Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(value));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...getAppSettingsSnapshot(),
        ...patch,
      }),
    );
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
