import type {
  BackgroundActivityProfile,
  BackgroundActivitySettings,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  SidebarProjectGroupingMode,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_WALLPAPER_IMAGE_DATA_URL_CHARS,
} from "@t3tools/contracts/settings";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import {
  compressImageForStash,
  type ImageCompressionFailureReason,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
} from "../../lib/imageCompression";
import { IMAGE_HEADER_BYTES, readImageDimensions } from "../../lib/imageDimensions";

export function isProjectGroupingEnabled(mode: SidebarProjectGroupingMode): boolean {
  return mode !== "separate";
}

export function projectGroupingModeFromToggle(
  enabled: boolean,
  lastEnabledMode: SidebarProjectGroupingMode = "repository",
): SidebarProjectGroupingMode {
  if (!enabled) return "separate";
  return lastEnabledMode === "repository_path" ? "repository_path" : "repository";
}

const LAST_ENABLED_PROJECT_GROUPING_MODE_KEY = "t3code:last-enabled-project-grouping-mode";

export function readLastEnabledProjectGroupingMode(): SidebarProjectGroupingMode {
  try {
    return localStorage.getItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY) === "repository_path"
      ? "repository_path"
      : "repository";
  } catch {
    return "repository";
  }
}

export function rememberEnabledProjectGroupingMode(mode: SidebarProjectGroupingMode): void {
  if (mode === "separate") return;
  try {
    localStorage.setItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY, mode);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function hasChangedBackgroundActivitySettings(
  settings: Pick<
    UnifiedSettings,
    | "backgroundActivity"
    | "backgroundActivityProfile"
    | "automaticGitFetchInterval"
    | "providerHealthRefreshInterval"
  >,
): boolean {
  return (
    !Equal.equals(settings.backgroundActivity, DEFAULT_UNIFIED_SETTINGS.backgroundActivity) ||
    settings.backgroundActivityProfile !== DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile ||
    !Equal.equals(
      settings.automaticGitFetchInterval,
      DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    ) ||
    !Equal.equals(
      settings.providerHealthRefreshInterval,
      DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
    )
  );
}

type TypographySettings = Pick<
  UnifiedSettings,
  | "fontFamilySans"
  | "fontFamilyComposer"
  | "fontFamilyCode"
  | "fontFamilyTerminal"
  | "fontSizeInterface"
  | "fontSizePrompt"
  | "fontSizeCode"
  | "fontSizeTerminal"
>;

/** Labels the font rows whose family or size differs from the defaults. */
export function getChangedTypographySettingLabels(settings: TypographySettings): string[] {
  return [
    ...(settings.fontFamilySans !== DEFAULT_UNIFIED_SETTINGS.fontFamilySans ||
    settings.fontSizeInterface !== DEFAULT_UNIFIED_SETTINGS.fontSizeInterface
      ? ["Interface font"]
      : []),
    ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer ||
    settings.fontSizePrompt !== DEFAULT_UNIFIED_SETTINGS.fontSizePrompt
      ? ["Prompt font"]
      : []),
    ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ||
    settings.fontSizeCode !== DEFAULT_UNIFIED_SETTINGS.fontSizeCode
      ? ["Code font"]
      : []),
    ...(settings.fontFamilyTerminal !== DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal ||
    settings.fontSizeTerminal !== DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal
      ? ["Terminal font"]
      : []),
  ];
}

export function resolveBackgroundActivityProfileOption(
  settings: ServerSettings,
): BackgroundActivityProfile | "advanced" {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const normalized = normalizeBackgroundActivitySettings({
    schemaVersion: 1,
    profile: "custom",
    baseProfile: resolved.profile,
    overrides: {
      automaticGitFetchInterval: resolved.automaticGitFetchInterval,
      providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
      hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
      hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
      idleClientTtl: resolved.idleClientTtl,
      pauseWhenHostLocked: resolved.pauseWhenHostLocked,
      pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
      pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
      pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    },
  });
  return normalized.profile === "custom" ? "advanced" : normalized.profile;
}

export function backgroundActivitySharedPolicySettings(
  settings: ServerSettings,
  profile: BackgroundActivityProfile,
): BackgroundActivitySettings {
  const normalized = normalizeServerBackgroundActivitySettings(settings);
  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: profile,
    overrides: normalized.profile === "custom" ? normalized.overrides : {},
  };
}

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }

  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  if (tracesBase !== metricsBase) {
    return null;
  }

  return `${tracesBase}/{traces,metrics}`;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string | undefined;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Terminal logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;

  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }

  if (tracesUrl) {
    return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  }

  if (metricsUrl) {
    return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  }

  return `${mode}.`;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

// ── Background-activity interval helpers ─────────────────────────────
// Shared by the General panel's interval rows and the Providers panel's
// health-check row.

export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

export function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

export function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.round(value));
}

export function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    idleClientTtl: resolved.idleClientTtl,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

// ── Wallpaper ────────────────────────────────────────────────────────

export type PreparedWallpaperImage =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: ImageCompressionFailureReason };

// A raster wallpaper decodes to width×height×4 bytes in the renderer and stays
// that big as a full-viewport background. The re-encode path already caps every
// dimension at MAX_DIMENSION (2048); this bounds the verbatim path, which stores
// the file untouched, so a highly compressible but enormous image (a uniform
// 16k×16k PNG is a few KB encoded, ~1 GB decoded) cannot freeze or OOM the tab.
// Generous enough for any real wallpaper (8K UHD is ~33M pixels).
const MAX_WALLPAPER_IMAGE_PIXELS = 40_000_000;

const SVG_DATA_URL_PREFIX = "data:image/svg+xml";

/**
 * Any `data:` image an SVG carries, whatever its encoding: the media subtype,
 * the parameters (which say whether it is base64), and the payload, which runs
 * to whichever delimiter closes the attribute, CSS function, or element.
 */
const EMBEDDED_IMAGE_PATTERN = /data:image\/([\w.+-]+)((?:;[^,"'()<>\s]*)*),([^"'()<>]*)/gi;
/** Base64 expansion of the header window: four characters per three bytes. */
const HEADER_BASE64_CHARS = Math.ceil(IMAGE_HEADER_BYTES / 3) * 4;
/** An SVG may wrap an SVG. Past this the nesting is not a wallpaper. */
const MAX_SVG_EMBED_DEPTH = 4;

/** Base64 payload as bytes, or null when it is not valid base64. */
function decodeBase64(payload: string, maxCharacters: number): Uint8Array | null {
  const compact = payload.replace(/\s/g, "").slice(0, maxCharacters);
  // atob rejects a partial group, and a truncated window usually lands on one.
  const whole = compact.slice(0, compact.length - (compact.length % 4));
  let binary: string;
  try {
    binary = atob(whole);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Percent-decoded payload as bytes. `decodeURIComponent` is no use here: a
 * raster's bytes are not UTF-8, and `%89` from a PNG signature makes it throw.
 */
function decodePercentEncoded(payload: string, maxBytes: number): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < payload.length && bytes.length < maxBytes; index += 1) {
    const byte =
      payload[index] === "%"
        ? Number.parseInt(payload.slice(index + 1, index + 3), 16)
        : Number.NaN;
    if (Number.isNaN(byte)) {
      bytes.push(payload.charCodeAt(index) & 0xff);
      continue;
    }
    bytes.push(byte);
    index += 2;
  }
  return new Uint8Array(bytes);
}

/**
 * Total pixels of the images an SVG embeds, or null when one of them cannot be
 * measured. A viewBox is not memory, which is why vectors are exempt from the
 * ceiling — but a few kilobytes of markup can wrap an enormous encoded raster,
 * and the viewport the browser reports for the vector says nothing about it.
 * Painting the wallpaper holds every embedded raster at once, so they are
 * summed; an embed this cannot read leaves the whole file unmeasurable rather
 * than exempt. Externally referenced images are not considered: an SVG loaded
 * as an image cannot fetch them. The scan is textual, so markup that spells a
 * `data:` URL through character references reads as no embed at all. This is a
 * bound on a file the user picked for their own window, not a defense against
 * an attacker: a wallpaper never reaches anybody else.
 */
function embeddedImagePixels(svgSource: string, depth = 0): number | null {
  let pixels = 0;
  for (const match of svgSource.matchAll(EMBEDDED_IMAGE_PATTERN)) {
    const [, subtype = "", parameters = "", payload = ""] = match;
    const isVectorEmbed = subtype.toLowerCase().startsWith("svg");
    const isBase64 = parameters.toLowerCase().includes(";base64");
    // A nested vector is read whole, since its own embeds can sit anywhere in it.
    const limit = isVectorEmbed ? Number.POSITIVE_INFINITY : IMAGE_HEADER_BYTES;
    const bytes = isBase64
      ? decodeBase64(payload, isVectorEmbed ? Number.POSITIVE_INFINITY : HEADER_BASE64_CHARS)
      : decodePercentEncoded(payload, limit);
    if (bytes === null) return null;

    if (isVectorEmbed) {
      if (depth >= MAX_SVG_EMBED_DEPTH) return null;
      const nested = embeddedImagePixels(new TextDecoder().decode(bytes), depth + 1);
      if (nested === null) return null;
      pixels += nested;
      continue;
    }
    const size = readImageDimensions(bytes);
    if (size === null) return null;
    pixels += size.width * size.height;
  }
  return pixels;
}

/**
 * The pixel count a file states in its own bytes, or null when it states none.
 * Decoding is what materializes the bitmap, so this is the only measurement
 * that can refuse an image without first paying for it — which makes an
 * unmeasurable file one to refuse, not one to wave through.
 */
async function declaredPixelCount(file: File, dataUrl: string): Promise<number | null> {
  if (dataUrl.startsWith(SVG_DATA_URL_PREFIX)) {
    return embeddedImagePixels(await file.text());
  }
  const header = await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer();
  const size = readImageDimensions(new Uint8Array(header));
  return size === null ? null : size.width * size.height;
}

/**
 * The decoded pixel size of `dataUrl`, or null when the browser cannot paint it.
 * The wallpaper is a CSS `background-image` and previews in an `<img>`, so an
 * element decode is the test that matches where it ends up: `createImageBitmap`
 * answers a stricter question — it refuses SVG sources outright, and those paint
 * perfectly well as a background.
 */
async function decodedImageSize(
  dataUrl: string,
): Promise<{ width: number; height: number } | null> {
  const probe = new Image();
  probe.src = dataUrl;
  try {
    await probe.decode();
    return { width: probe.naturalWidth, height: probe.naturalHeight };
  } catch {
    return null;
  }
}

/**
 * The data URL to persist for a picked wallpaper file.
 *
 * Two things the compressor does not do on its own. The source ceiling is
 * checked before the file is touched, because reading it into a base64 string
 * is itself what would take the tab down — past that point there is nothing
 * left to protect. And a file small enough to store verbatim never reaches the
 * decoder, so it is probed here: `accept="image/*"` only filters the picker,
 * and persisting a mislabeled file would leave a wallpaper that renders as a
 * broken image with no error ever shown.
 */
export async function prepareWallpaperImage(file: File): Promise<PreparedWallpaperImage> {
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const compressed = await compressImageForStash(file, MAX_WALLPAPER_IMAGE_DATA_URL_CHARS);
  if (!compressed.ok) {
    return compressed;
  }
  // Re-encoding already decoded the file and bounded its dimensions, so only the
  // verbatim path is unproven — both that it decodes and that it is not enormous.
  if (!compressed.image.recompressed) {
    // Ordered so the ceiling lands before any decode: the decode is what spends
    // the memory, so measuring first is the difference between refusing an image
    // and OOMing on it. A file that states no size at all is refused for the same
    // reason — waving it through would put the decode back in front of the check.
    const declaredPixels = await declaredPixelCount(file, compressed.image.dataUrl);
    if (declaredPixels === null) {
      return { ok: false, reason: "unreadable" };
    }
    if (declaredPixels > MAX_WALLPAPER_IMAGE_PIXELS) {
      return { ok: false, reason: "too-large" };
    }
    const size = await decodedImageSize(compressed.image.dataUrl);
    if (size === null) {
      return { ok: false, reason: "unreadable" };
    }
    // Backstop for a header that understates what it decodes to. SVG is exempt:
    // naturalWidth/Height are a viewBox, not a raster the tab must hold, and
    // whatever it embeds was measured above.
    const isVector = compressed.image.dataUrl.startsWith(SVG_DATA_URL_PREFIX);
    if (!isVector && size.width * size.height > MAX_WALLPAPER_IMAGE_PIXELS) {
      return { ok: false, reason: "too-large" };
    }
  }
  return { ok: true, dataUrl: compressed.image.dataUrl };
}
