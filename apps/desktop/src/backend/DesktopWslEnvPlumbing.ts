/** WSL environment plumbing: which host variables reach the distro, and how WSLENV is merged. */
export const WSL_FORWARDED_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "T3CODE_TELEMETRY_ENABLED",
  "T3CODE_GITHUB_APP_CLIENT_ID",
  // Otherwise the WSL server keeps exporting to endpoints from the bootstrap.
  "T3CODE_OTEL_SDK_DISABLED",
  "OTEL_SDK_DISABLED",
  "T3CODE_OTLP_HEADERS",
  "T3CODE_OTLP_PROTOCOL",
  // Untranslated T3 URLs must override bootstrap endpoints inside WSL, as they do on Windows.
  "T3CODE_OTLP_TRACES_URL",
  "T3CODE_OTLP_METRICS_URL",
  "T3CODE_OTLP_LOGS_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

export const WSL_SERVER_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const nodeBinDirOf = (nodePath: string): string => {
  const lastSlash = nodePath.lastIndexOf("/");
  return lastSlash > 0 ? nodePath.slice(0, lastSlash) : "/usr/bin";
};

export const getWslEnvEntryName = (entry: string): string => {
  const slashIndex = entry.indexOf("/");
  return slashIndex === -1 ? entry : entry.slice(0, slashIndex);
};

export const mergeWslEnv = (
  existingWslEnv: string | undefined,
  forwardedEnvNames: ReadonlyArray<string>,
): string | undefined => {
  const existing = existingWslEnv?.trim() ?? "";

  const seenNames = new Set(
    existing
      .split(":")
      .map((entry) => getWslEnvEntryName(entry.trim()))
      .filter((name) => name.length > 0),
  );

  const additions = forwardedEnvNames.filter((name) => !seenNames.has(name));

  // Preserve empty segments and duplicates in the user's WSLENV; only append required variables.
  const parts = [existing, ...additions].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(":") : undefined;
};
