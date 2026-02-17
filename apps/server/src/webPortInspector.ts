import { request as httpRequest } from "node:http";

export const DEFAULT_WEB_PORT_PROBE_TTL_MS = 10_000;
const DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS = 2_000;
const WEB_PORT_PROBE_MAX_BODY_BYTES = 8_192;

interface WebProbeResult {
  status: number;
  contentType: string;
  body: string;
  location: string;
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

function isLikelyWebProbe(result: WebProbeResult | null): boolean {
  if (!result) return false;
  if (result.status === 404) return false;
  if (result.status >= 300 && result.status < 400 && result.location.length > 0) {
    return true;
  }
  const contentType = result.contentType.toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }
  const body = result.body.toLowerCase();
  return (
    body.includes("<!doctype") ||
    body.includes("<html") ||
    body.includes("<head")
  );
}

async function probeWebPortOnHost(
  port: number,
  host: string,
): Promise<WebProbeResult | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (result: WebProbeResult | null) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const req = httpRequest(
      {
        host,
        port,
        method: "GET",
        path: "/",
        timeout: DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = normalizeHeaderValue(res.headers["content-type"]);
        const location = normalizeHeaderValue(res.headers.location);

        const settleFromChunks = (chunks: string[]) => {
          settle({
            status,
            contentType,
            location,
            body: chunks.join(""),
          });
        };

        // Resolve immediately for clear web responses based on status/headers.
        if (
          (status >= 300 && status < 400 && location.length > 0) ||
          contentType.toLowerCase().includes("text/html") ||
          contentType.toLowerCase().includes("application/xhtml+xml")
        ) {
          settle({
            status,
            contentType,
            location,
            body: "",
          });
          req.destroy();
          return;
        }

        const chunks: string[] = [];
        let received = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (received >= WEB_PORT_PROBE_MAX_BODY_BYTES) return;
          const remaining = WEB_PORT_PROBE_MAX_BODY_BYTES - received;
          const fragment = chunk.slice(0, remaining);
          received += fragment.length;
          chunks.push(fragment);
          if (received >= WEB_PORT_PROBE_MAX_BODY_BYTES) {
            settleFromChunks(chunks);
            res.destroy();
          }
        });
        res.on("end", () => {
          settleFromChunks(chunks);
        });
        res.on("error", () => {
          settle(null);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      settle(null);
    });
    req.on("error", () => {
      settle(null);
    });

    timer = setTimeout(() => {
      req.destroy();
      settle(null);
    }, DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS + 50);

    req.end();
  });
}

export async function defaultWebPortInspector(port: number): Promise<boolean> {
  const ipv4Result = await probeWebPortOnHost(port, "127.0.0.1");
  if (isLikelyWebProbe(ipv4Result)) {
    return true;
  }
  const ipv6Result = await probeWebPortOnHost(port, "::1");
  return isLikelyWebProbe(ipv6Result);
}
