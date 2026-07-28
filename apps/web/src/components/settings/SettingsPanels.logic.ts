import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  SidebarProjectGroupingMode,
  UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";

export function hasChangedGeneralServerSettings(settings: ServerSettings): boolean {
  return (
    settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ||
    settings.enableProviderUpdateChecks !== DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ||
    Duration.toMillis(settings.automaticGitFetchInterval) !==
      Duration.toMillis(DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval) ||
    settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ||
    settings.newWorktreesStartFromOrigin !== DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ||
    settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ||
    !Equal.equals(
      settings.textGenerationModelSelection,
      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    )
  );
}

export function buildGeneralSettingsRestorePatch(input: {
  readonly includeServerSettings: boolean;
}): Partial<UnifiedSettings> {
  return {
    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
    wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
    glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
    sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
    ...(input.includeServerSettings
      ? {
          enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
          enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
          automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
          defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
          newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
          addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
          textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
        }
      : {}),
  };
}

export function resolveSettingsEnvironmentId(input: {
  readonly availableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const availableIds = new Set(input.availableEnvironmentIds);
  const candidates = [
    input.selectedEnvironmentId,
    input.primaryEnvironmentId,
    input.activeEnvironmentId,
    input.availableEnvironmentIds[0] ?? null,
  ];

  for (const candidate of candidates) {
    if (candidate !== null && availableIds.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

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
