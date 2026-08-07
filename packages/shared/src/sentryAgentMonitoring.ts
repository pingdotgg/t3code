export interface SentryOtlpConfig {
  readonly tracesUrl: string;
  readonly authHeader: string;
}

/** Derive Sentry's project-scoped OTLP endpoint without retaining the DSN. */
export function parseSentryDsn(dsn: string): SentryOtlpConfig | null {
  try {
    const url = new URL(dsn.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username.length === 0) {
      return null;
    }

    const pathSegments = url.pathname.split("/").filter(Boolean);
    const projectId = pathSegments.pop();
    if (!projectId || !/^\d+$/.test(projectId)) {
      return null;
    }

    const publicKey = decodeURIComponent(url.username);
    if (publicKey.length === 0) {
      return null;
    }

    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = `/${[...pathSegments, "api", projectId, "integration", "otlp", "v1", "traces"].join("/")}`;

    return {
      tracesUrl: url.toString(),
      authHeader: `sentry sentry_key=${publicKey}`,
    };
  } catch {
    return null;
  }
}
