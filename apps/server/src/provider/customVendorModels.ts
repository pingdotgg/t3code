import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/http";

import { isDeepSeekEndpoint } from "./deepseekUsageLimits.ts";
import { isZhipuEndpoint } from "./zhipuUsageLimits.ts";

type CustomAnthropicVendor = "zhipu" | "deepseek";

export function detectCustomAnthropicVendor(
  baseUrl: string | undefined,
): CustomAnthropicVendor | undefined {
  if (isZhipuEndpoint(baseUrl)) return "zhipu";
  if (isDeepSeekEndpoint(baseUrl)) return "deepseek";
  return undefined;
}

const FALLBACK_VENDOR_MODELS: Record<CustomAnthropicVendor, ReadonlyArray<string>> = {
  zhipu: ["glm-5.4", "glm-5.3", "glm-5.3-flash"],
  deepseek: ["deepseek-v4-pro[1m]", "deepseek-flash", "deepseek-reasoner", "deepseek-chat"],
};

function resolveVendorModelsUrl(
  vendor: CustomAnthropicVendor,
  baseUrl: string,
): string | undefined {
  const parsed = URL.parse(baseUrl.trim());
  if (!parsed) return undefined;
  if (vendor === "deepseek") {
    return `${parsed.origin}/models`;
  }
  return `${parsed.origin}/api/paas/v4/models`;
}

function isRelevantVendorModelId(vendor: CustomAnthropicVendor, id: string): boolean {
  const lower = id.trim().toLowerCase();
  if (!lower) return false;
  if (vendor === "deepseek") {
    return lower.startsWith("deepseek");
  }
  // Keep GLM coding/chat models; skip embedding, image, video, audio, rerank, moderation models.
  if (!lower.startsWith("glm-") && !lower.startsWith("codegeex")) return false;
  if (
    /(embedding|rerank|cogview|cogvideo|tts|asr|audio|realtime|voice|ocr|charglm|emohaa)/.test(
      lower,
    )
  ) {
    return false;
  }
  return true;
}

function formatCustomVendorModelName(vendor: CustomAnthropicVendor, slug: string): string {
  const trimmed = slug.trim();
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (vendor === "zhipu") {
    const match = base.match(/^glm-(.+)$/i);
    if (match?.[1]) {
      const rest = match[1]
        .split("-")
        .map((part) => {
          if (/^\d+(\.\d+)*$/.test(part)) return part;
          if (
            /^(air|airx|flash|flashx|plus|pro|max|turbo|vision|v|zero|long|coding)$/i.test(part)
          ) {
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
          }
          return part.toUpperCase();
        })
        .join(" ");
      // Keep "GLM-5.4" or "GLM-5.3 Flash" crisp.
      const firstSpace = rest.indexOf(" ");
      return firstSpace === -1
        ? `GLM-${rest}`
        : `GLM-${rest.slice(0, firstSpace)} ${rest.slice(firstSpace + 1)}`;
    }
    return base;
  }

  // DeepSeek formatting: e.g. deepseek-v4-pro[1m] -> DeepSeek V4 Pro (1M)
  const ctxMatch = base.match(/^(.+?)\[([^\]]+)\]$/);
  const core = ctxMatch?.[1] ?? base;
  const ctxTag = ctxMatch?.[2] ? ` (${ctxMatch[2].toUpperCase()})` : "";
  const formatted = core
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "deepseek") return "DeepSeek";
      if (/^v\d+(\.\d+)*$/i.test(part) || /^r\d+$/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
  return `${formatted}${ctxTag}`;
}

function modelSortScore(vendor: CustomAnthropicVendor, slug: string): number {
  const lower = slug.toLowerCase();
  if (vendor === "zhipu") {
    const verMatch = lower.match(/glm-(\d+)(?:\.(\d+))?/);
    const major = verMatch ? Number(verMatch[1]) : 0;
    const minor = verMatch?.[2] ? Number(verMatch[2]) : 0;
    let tier = 50;
    if (lower.includes("max")) tier = 70;
    else if (lower.includes("plus") || lower.includes("pro")) tier = 60;
    else if (lower.includes("flash")) tier = 30;
    else if (lower.includes("air")) tier = 20;
    else if (lower.includes("vision") || lower.endsWith("v")) tier = 25;
    return major * 10_000 + minor * 100 + tier;
  }
  // DeepSeek: prefer V4 Pro > V4 > Reasoner > R1 > V3 > Flash > Chat
  if (lower.includes("v4-pro")) return 10_000;
  if (lower.includes("v4")) return 9_000;
  if (lower.includes("reasoner")) return 8_000;
  if (lower.includes("r1")) return 7_500;
  if (lower.includes("v3")) return 7_000;
  if (lower.includes("flash")) return 6_500;
  if (lower.includes("chat")) return 6_000;
  return 5_000;
}

function extractModelIdsFromPayload(payload: unknown): ReadonlyArray<string> {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      ids.push(item.trim());
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const id =
        typeof obj.id === "string"
          ? obj.id.trim()
          : typeof obj.model === "string"
            ? obj.model.trim()
            : typeof obj.name === "string"
              ? obj.name.trim()
              : "";
      if (id) ids.push(id);
    }
  }
  return ids;
}

const fetchLiveVendorModelIds = (
  client: HttpClient.HttpClient,
  vendor: CustomAnthropicVendor,
  url: string,
  apiKey: string,
): Effect.Effect<ReadonlyArray<string>> => {
  const bearerHeader = apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`;
  return client
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          Authorization: bearerHeader,
          Accept: "application/json",
        }),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? response.json.pipe(Effect.orElseSucceed(() => undefined as unknown))
          : Effect.succeed(undefined as unknown),
      ),
      Effect.timeout("8 seconds"),
      Effect.map((json) =>
        extractModelIdsFromPayload(json).filter((id) => isRelevantVendorModelId(vendor, id)),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );
};

export const fetchCustomVendorModels = Effect.fn("fetchCustomVendorModels")(function* (input: {
  readonly vendor: CustomAnthropicVendor;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly customModels: ReadonlyArray<string>;
  readonly envModels: ReadonlyArray<string | undefined>;
  readonly capabilities: ServerProviderModel["capabilities"];
}): Effect.fn.Return<ReadonlyArray<ServerProviderModel>> {
  const url = resolveVendorModelsUrl(input.vendor, input.baseUrl);
  const apiKey = input.apiKey?.trim();
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  const liveIds =
    url && apiKey && Option.isSome(httpClient)
      ? yield* fetchLiveVendorModelIds(httpClient.value, input.vendor, url, apiKey)
      : [];

  const envIds = input.envModels
    .map((m) => m?.trim() ?? "")
    .filter((m) => m.length > 0 && isRelevantVendorModelId(input.vendor, m));
  const customIds = input.customModels.map((m) => m.trim()).filter((m) => m.length > 0);

  // Merge user-configured models, env-configured models, live API models, and curated flagship fallbacks.
  const combined = new Map<string, string>();
  const addId = (id: string) => {
    const key = id.toLowerCase();
    if (!combined.has(key)) combined.set(key, id);
  };
  for (const id of customIds) addId(id);
  for (const id of envIds) addId(id);
  for (const id of liveIds) addId(id);
  if (combined.size === 0) {
    for (const id of FALLBACK_VENDOR_MODELS[input.vendor]) addId(id);
  }

  const ordered = [...combined.values()].sort((a, b) => {
    const scoreDiff = modelSortScore(input.vendor, b) - modelSortScore(input.vendor, a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.localeCompare(b);
  });

  // Cap live list to top 12 flagship/active models so the picker stays crisp.
  const capped = ordered.slice(0, 12);
  return capped.map((slug, index) => ({
    slug,
    name: formatCustomVendorModelName(input.vendor, slug),
    isCustom: customIds.some((id) => id.toLowerCase() === slug.toLowerCase()),
    ...(index === 0 ? { isDefault: true } : {}),
    capabilities: input.capabilities,
  }));
});
