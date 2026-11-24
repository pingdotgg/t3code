import { BRAND_DESKTOP_PROTOCOLS } from "./brand.ts";
import { isLoopbackHost } from "./preview.ts";

function resolveDefaultHostedAppOrigins(): ReadonlyArray<string> {
  const origins = ["https://app.t3.codes"];
  if (typeof process !== "undefined" && process.env) {
    for (const candidate of [process.env.T3CODE_HOSTED_APP_URL, process.env.HOSTED_APP_URL]) {
      const trimmed = candidate?.trim();
      if (!trimmed) continue;
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "https:" || isLoopbackHost(parsed.hostname)) {
          if (!origins.includes(parsed.origin)) {
            origins.push(parsed.origin);
          }
        }
      } catch {
        // Ignore invalid configured URLs.
      }
    }
  }
  return origins;
}

export function providerAuthReturnUrl(
  value: string | undefined,
  hostedAppOrigin?: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const allowedOrigins = hostedAppOrigin ? [hostedAppOrigin] : resolveDefaultHostedAppOrigins();
    const desktop =
      (BRAND_DESKTOP_PROTOCOLS as ReadonlyArray<string>).includes(url.protocol) &&
      url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || allowedOrigins.includes(url.origin));
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
