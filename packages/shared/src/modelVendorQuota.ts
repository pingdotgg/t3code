import {
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import {
  type LimitPace,
  paceOf,
  paceRemainingPercent,
  providersWithLimits,
  remainingPercent,
} from "./usageLimits.ts";

export const MODEL_VENDOR_IDS = ["claude", "gpt", "gemini", "glm", "deepseek"] as const;
export type ModelVendorId = (typeof MODEL_VENDOR_IDS)[number];

export type ModelVendorTabId = `vendor:${ModelVendorId}`;

export function modelVendorTabId(vendor: ModelVendorId): ModelVendorTabId {
  return `vendor:${vendor}`;
}

export function isModelVendorTabId(value: string): value is ModelVendorTabId {
  return (
    value === "vendor:claude" ||
    value === "vendor:gpt" ||
    value === "vendor:gemini" ||
    value === "vendor:glm" ||
    value === "vendor:deepseek"
  );
}

export function parseModelVendorTabId(value: string): ModelVendorId | null {
  if (!isModelVendorTabId(value)) return null;
  return value.slice("vendor:".length) as ModelVendorId;
}

export function modelVendorDisplayName(vendor: ModelVendorId): string {
  switch (vendor) {
    case "claude":
      return "Claude";
    case "gpt":
      return "GPT";
    case "gemini":
      return "Gemini";
    case "glm":
      return "GLM";
    case "deepseek":
      return "DeepSeek";
  }
}

export function modelVendorIconDriver(vendor: ModelVendorId): ProviderDriverKind {
  switch (vendor) {
    case "claude":
      return ProviderDriverKind.make("claudeAgent");
    case "gpt":
      return ProviderDriverKind.make("codex");
    case "gemini":
      return ProviderDriverKind.make("antigravity");
    case "glm":
    case "deepseek":
      return ProviderDriverKind.make("claudeAgent");
  }
}

export function modelVendorAccentColor(vendor: ModelVendorId): string {
  switch (vendor) {
    case "claude":
      return "#d97757";
    case "gpt":
      return "#10a37f";
    case "gemini":
      return "#5b87bf";
    case "glm":
      return "#3859FF";
    case "deepseek":
      return "#4D6BFE";
  }
}

/**
 * Classifies a model into one of the three primary model vendor families (Claude, GPT, Gemini).
 * Works across native providers (Claude, Codex) and multi-vendor gateways like Antigravity
 * (which serves Gemini, Claude/Opus, and GPT models under one Google account).
 */
export function classifyModelVendor(input: {
  readonly slug: string;
  readonly name?: string | undefined;
  readonly driverKind?: ProviderDriverKind | undefined;
  readonly subProvider?: string | undefined;
}): ModelVendorId | null {
  const slug = input.slug.trim();
  const base = slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();
  const name = (input.name ?? "").trim().toLowerCase();
  const sub = (input.subProvider ?? "").trim().toLowerCase();

  if (
    /^deepseek\b|^deepseek-/.test(base) ||
    /\bdeepseek\b/.test(name) ||
    sub.includes("deepseek")
  ) {
    return "deepseek";
  }
  if (
    /^glm\b|^glm-|^chatglm/.test(base) ||
    /\b(glm|chatglm|zhipu)\b/.test(name) ||
    sub.includes("zhipu") ||
    sub.includes("bigmodel") ||
    sub.includes("glm")
  ) {
    return "glm";
  }
  if (
    /^(claude|opus|sonnet|haiku)\b|^claude-/.test(base) ||
    /\b(claude|opus|sonnet|haiku)\b/.test(name) ||
    sub.includes("anthropic") ||
    sub.includes("claude")
  ) {
    return "claude";
  }
  if (
    /^(gpt|o1|o3|o4|codex|chatgpt)\b|^gpt-|^o[134]-/.test(base) ||
    /\b(gpt|codex|chatgpt|o[134]-mini|o[134]-pro|o[134])\b/.test(name) ||
    sub.includes("openai")
  ) {
    return "gpt";
  }
  if (
    /^(gemini|gemma)\b|^gemini-/.test(base) ||
    /\b(gemini|gemma)\b/.test(name) ||
    sub.includes("google") ||
    sub.includes("gemini")
  ) {
    return "gemini";
  }

  switch (input.driverKind) {
    case "claudeAgent":
    case "anthropic":
      return "claude";
    case "codex":
    case "openai":
      return "gpt";
    default:
      return null;
  }
}

/**
 * Maps an Antigravity usage window to the vendor family(ies) it meters.
 * Antigravity's `3p-*` buckets meter third-party Claude (Opus/Sonnet) & GPT models together,
 * while `claude-*`, `gpt-*`, and `gemini-*` buckets meter their respective families.
 */
export function classifyAntigravityWindowVendors(
  window: Pick<ServerProviderUsageWindow, "id" | "label" | "modelIds">,
): ReadonlyArray<ModelVendorId> {
  const id = window.id.toLowerCase();
  const label = window.label.toLowerCase();

  if (id.startsWith("gemini") || label.includes("gemini")) {
    return ["gemini"];
  }
  if (id.startsWith("3p-") || (label.includes("claude") && label.includes("gpt"))) {
    return ["claude", "gpt"];
  }
  if (
    id.startsWith("claude") ||
    id.includes("opus") ||
    label.includes("claude") ||
    label.includes("opus")
  ) {
    return ["claude"];
  }
  if (id.startsWith("gpt") || label.includes("gpt")) {
    return ["gpt"];
  }
  if (window.modelIds?.length) {
    const matched = new Set<ModelVendorId>();
    for (const modelId of window.modelIds) {
      const vendor = classifyModelVendor({ slug: modelId });
      if (vendor) matched.add(vendor);
    }
    if (matched.size > 0) return [...matched];
  }
  return [];
}

export interface VendorQuotaWindowItem {
  readonly key: string;
  readonly window: ServerProviderUsageWindow;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly pace: LimitPace | null;
  readonly paceRemainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly checkedAt: string;
  readonly sourceName: string;
  readonly sourceDriver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly viaAntigravity: boolean;
  readonly sharedPool: boolean;
}

export interface VendorQuotaSummary {
  readonly vendor: ModelVendorId;
  readonly windows: ReadonlyArray<VendorQuotaWindowItem>;
  readonly viaAntigravityOnly: boolean;
  readonly latestCheckedAt: string | null;
  /** Lowest remaining percent across this vendor's windows (null when no readable windows). */
  readonly minRemainingPercent: number | null;
  /** Highest used percent across this vendor's windows (null when no readable windows). */
  readonly maxUsedPercent: number | null;
  readonly unavailableMessage: string | null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function makeWindowItem(input: {
  readonly key: string;
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly checkedAt: string;
  readonly sourceName: string;
  readonly sourceDriver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly viaAntigravity: boolean;
  readonly sharedPool: boolean;
}): VendorQuotaWindowItem {
  const used = clampPercent(input.window.usedPercent);
  const remaining = remainingPercent(input.window);
  return {
    key: input.key,
    window: input.window,
    usedPercent: used,
    remainingPercent: remaining,
    pace: paceOf(input.window, input.now),
    paceRemainingPercent: paceRemainingPercent(input.window, input.now),
    resetsAt: input.window.resetsAt ?? null,
    checkedAt: input.checkedAt,
    sourceName: input.sourceName,
    sourceDriver: input.sourceDriver,
    instanceId: input.instanceId,
    viaAntigravity: input.viaAntigravity,
    sharedPool: input.sharedPool,
  };
}

function latestTimestamp(timestamps: ReadonlyArray<string>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const ts of timestamps) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = ts;
    }
  }
  return best;
}

function sortQuotaWindows(
  items: ReadonlyArray<VendorQuotaWindowItem>,
): ReadonlyArray<VendorQuotaWindowItem> {
  const kindRank = (kind: ServerProviderUsageWindow["kind"]) =>
    kind === "session" ? 0 : kind === "weekly" ? 1 : 2;
  return [...items].sort((a, b) => {
    // Native provider windows first, then Antigravity windows.
    if (a.viaAntigravity !== b.viaAntigravity) return a.viaAntigravity ? 1 : -1;
    const rankDiff = kindRank(a.window.kind) - kindRank(b.window.kind);
    if (rankDiff !== 0) return rankDiff;
    return a.window.label.localeCompare(b.window.label);
  });
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName?.trim() || PROVIDER_DISPLAY_NAMES[provider.driver] || provider.driver;
}

export function resolveCustomClaudeVendor(provider: ServerProvider): ModelVendorId | undefined {
  if (provider.driver !== "claudeAgent") return undefined;
  const endpoint = provider.auth.endpoint?.toLowerCase() ?? "";
  if (endpoint.includes("deepseek.com")) return "deepseek";
  if (endpoint.includes("bigmodel.cn") || endpoint.includes("z.ai")) return "glm";
  if (provider.usageLimits?.windows.some((window) => window.id.startsWith("deepseek-"))) {
    return "deepseek";
  }
  if (
    provider.usageLimits?.windows.some(
      (window) => window.id.startsWith("zhipu-") || window.id.startsWith("glm-"),
    )
  ) {
    return "glm";
  }
  const customModels = provider.models.filter((model) => model.isCustom);
  if (customModels.length > 0) {
    if (
      customModels.every(
        (model) => classifyModelVendor({ slug: model.slug, name: model.name }) === "deepseek",
      )
    ) {
      return "deepseek";
    }
    if (
      customModels.every(
        (model) => classifyModelVendor({ slug: model.slug, name: model.name }) === "glm",
      )
    ) {
      return "glm";
    }
  }
  return undefined;
}

/**
 * Aggregates real-time quota windows by vendor family (Claude, GPT, Gemini, GLM, DeepSeek).
 * Maps Antigravity's Claude/Opus (`3p-*` / `claude-*`) quota under `claude` (tagged `viaAntigravity`).
 */
export function collectVendorQuotas(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources?: UsageLimitSourceSnapshots | undefined;
  readonly now: number;
}): Readonly<Record<ModelVendorId, VendorQuotaSummary>> {
  const buckets: Record<ModelVendorId, VendorQuotaWindowItem[]> = {
    claude: [],
    gpt: [],
    gemini: [],
    glm: [],
    deepseek: [],
  };
  const checkedAtByVendor: Record<ModelVendorId, string[]> = {
    claude: [],
    gpt: [],
    gemini: [],
    glm: [],
    deepseek: [],
  };
  const unavailableByVendor: Record<ModelVendorId, string | null> = {
    claude: null,
    gpt: null,
    gemini: null,
    glm: null,
    deepseek: null,
  };
  const seenKeys = new Set<string>();

  const pushItem = (vendor: ModelVendorId, item: VendorQuotaWindowItem) => {
    const dedupeKey = `${vendor}:${item.key}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    buckets[vendor].push(item);
    checkedAtByVendor[vendor].push(item.checkedAt);
  };

  const addLimits = (params: {
    readonly driver: ProviderDriverKind;
    readonly sourceName: string;
    readonly instanceId: ProviderInstanceId | null;
    readonly limits: ServerProviderUsageLimits;
    readonly idPrefix: string;
    readonly vendorOverride?: ModelVendorId | undefined;
  }) => {
    const { driver, sourceName, instanceId, limits, idPrefix, vendorOverride } = params;
    if (limits.unavailable) {
      const msg = limits.unavailable.message ?? null;
      if (vendorOverride) unavailableByVendor[vendorOverride] ??= msg;
      else if (driver === "claudeAgent") unavailableByVendor.claude ??= msg;
      else if (driver === "codex") unavailableByVendor.gpt ??= msg;
      else if (driver === "antigravity") {
        unavailableByVendor.gemini ??= msg;
        unavailableByVendor.claude ??= msg;
      }
      return;
    }

    if (driver === "claudeAgent") {
      const targetVendor =
        vendorOverride ??
        (limits.windows.some((w) => w.id.startsWith("deepseek-"))
          ? "deepseek"
          : limits.windows.some((w) => w.id.startsWith("zhipu-") || w.id.startsWith("glm-"))
            ? "glm"
            : "claude");
      for (const window of limits.windows) {
        pushItem(
          targetVendor,
          makeWindowItem({
            key: `${idPrefix}:${window.id}`,
            window,
            now: input.now,
            checkedAt: limits.checkedAt,
            sourceName,
            sourceDriver: driver,
            instanceId,
            viaAntigravity: false,
            sharedPool: false,
          }),
        );
      }
      return;
    }

    if (driver === "codex") {
      for (const window of limits.windows) {
        pushItem(
          "gpt",
          makeWindowItem({
            key: `${idPrefix}:${window.id}`,
            window,
            now: input.now,
            checkedAt: limits.checkedAt,
            sourceName,
            sourceDriver: driver,
            instanceId,
            viaAntigravity: false,
            sharedPool: false,
          }),
        );
      }
      return;
    }

    if (driver === "antigravity") {
      for (const window of limits.windows) {
        const vendors = classifyAntigravityWindowVendors(window);
        const isShared = window.id.toLowerCase().startsWith("3p-");
        for (const vendor of vendors) {
          pushItem(
            vendor,
            makeWindowItem({
              key: `${idPrefix}:${window.id}`,
              window,
              now: input.now,
              checkedAt: limits.checkedAt,
              sourceName,
              sourceDriver: driver,
              instanceId,
              viaAntigravity: vendor !== "gemini",
              sharedPool: isShared,
            }),
          );
        }
      }
    }
  };

  for (const provider of providersWithLimits(input.providers)) {
    if (!provider.usageLimits) continue;
    addLimits({
      driver: provider.driver,
      sourceName: providerDisplayName(provider),
      instanceId: provider.instanceId,
      limits: provider.usageLimits,
      idPrefix: `native:${provider.instanceId}`,
      vendorOverride: resolveCustomClaudeVendor(provider),
    });
  }

  for (const source of input.sources ?? []) {
    for (const account of source.accounts) {
      addLimits({
        driver: account.driver,
        sourceName: source.label || PROVIDER_DISPLAY_NAMES[account.driver] || account.driver,
        instanceId: null,
        limits: account.usageLimits,
        idPrefix: `hub:${source.id}:${account.id}`,
      });
    }
  }

  const buildSummary = (vendor: ModelVendorId): VendorQuotaSummary => {
    const windows = sortQuotaWindows(buckets[vendor]);
    const viaAntigravityOnly =
      windows.length > 0 && windows.every((item) => item.sourceDriver === "antigravity");
    const minRemainingPercent =
      windows.length > 0 ? Math.min(...windows.map((item) => item.remainingPercent)) : null;
    const maxUsedPercent =
      windows.length > 0 ? Math.max(...windows.map((item) => item.usedPercent)) : null;
    return {
      vendor,
      windows,
      viaAntigravityOnly,
      latestCheckedAt: latestTimestamp(checkedAtByVendor[vendor]),
      minRemainingPercent,
      maxUsedPercent,
      unavailableMessage: windows.length === 0 ? unavailableByVendor[vendor] : null,
    };
  };

  return {
    claude: buildSummary("claude"),
    gpt: buildSummary("gpt"),
    gemini: buildSummary("gemini"),
    glm: buildSummary("glm"),
    deepseek: buildSummary("deepseek"),
  };
}

/**
 * Resolves quota windows for a single provider instance (used when a user selects a specific
 * provider tab in the model picker sidebar rather than a vendor tab).
 */
export function collectProviderInstanceQuota(input: {
  readonly provider: ServerProvider | undefined;
  readonly now: number;
}): {
  readonly title: string;
  readonly driver: ProviderDriverKind;
  readonly windows: ReadonlyArray<VendorQuotaWindowItem>;
  readonly latestCheckedAt: string | null;
  readonly unavailableMessage: string | null;
} | null {
  const provider = input.provider;
  if (!provider || !provider.enabled || !isProviderAvailable(provider)) return null;
  const limits = provider.usageLimits;
  const title = providerDisplayName(provider);
  if (!limits) {
    return {
      title,
      driver: provider.driver,
      windows: [],
      latestCheckedAt: null,
      unavailableMessage: null,
    };
  }
  if (limits.unavailable) {
    return {
      title,
      driver: provider.driver,
      windows: [],
      latestCheckedAt: limits.checkedAt,
      unavailableMessage: limits.unavailable.message ?? null,
    };
  }
  const windows = limits.windows.map((window) =>
    makeWindowItem({
      key: `instance:${provider.instanceId}:${window.id}`,
      window,
      now: input.now,
      checkedAt: limits.checkedAt,
      sourceName: title,
      sourceDriver: provider.driver,
      instanceId: provider.instanceId,
      viaAntigravity: false,
      sharedPool: provider.driver === "antigravity" && window.id.toLowerCase().startsWith("3p-"),
    }),
  );
  return {
    title,
    driver: provider.driver,
    windows,
    latestCheckedAt: limits.checkedAt,
    unavailableMessage: null,
  };
}
