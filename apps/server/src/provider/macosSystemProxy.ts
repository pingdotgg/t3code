import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
// CFNetwork never sends loopback through the system proxy; env-proxy clients do unless told.
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

function proxyUrl(fields: ReadonlyMap<string, string>, prefix: "HTTP" | "HTTPS"): string | null {
  const host = fields.get(`${prefix}Proxy`);
  const port = fields.get(`${prefix}Port`);
  if (fields.get(`${prefix}Enable`) !== "1" || !host || !port || !/^\d+$/.test(port)) {
    return null;
  }
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

// macOS writes `*.local` and `169.254/16` by default.
const LINK_LOCAL_RANGE = /^169\.254(?:\.0){0,2}\/16$/;

function toNoProxyEntry(exception: string): string {
  if (LINK_LOCAL_RANGE.test(exception)) return "169.254.0.0/16";
  return exception.startsWith("*.") ? exception.slice(1) : exception;
}

/**
 * npm matches NO_PROXY by hostname suffix and ignores IP ranges, so a bypassed
 * private registry would go through the proxy. Such bypass lists keep the direct connection.
 */
function hasUnrepresentableException(exception: string): boolean {
  if (LINK_LOCAL_RANGE.test(exception)) return false;
  return (
    exception.includes("/") || exception.slice(exception.startsWith("*.") ? 2 : 0).includes("*")
  );
}

/** Maps `scutil --proxy` output to proxy env vars; SOCKS and PAC are ignored. */
export function parseScutilProxy(output: string, inheritedNoProxy = ""): Record<string, string> {
  const fields = new Map<string, string>();
  const exceptions: Array<string> = [];
  let depth = 0;
  let inExceptions = false;
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (text === "}") {
      depth -= 1;
      if (depth <= 1) inExceptions = false;
      continue;
    }
    const separator = text.indexOf(" : ");
    const key = separator === -1 ? "" : text.slice(0, separator);
    const value = separator === -1 ? "" : text.slice(separator + 3).trim();
    if (text.endsWith("{")) {
      inExceptions = depth === 1 && key === "ExceptionsList";
      depth += 1;
    } else if (depth === 1 && key) {
      fields.set(key, value);
    } else if (inExceptions && depth === 2 && value) {
      exceptions.push(value);
    }
  }

  const proxy = proxyUrl(fields, "HTTP");
  const inherited = inheritedNoProxy.split(",").flatMap((entry) => entry.trim() || []);
  if (
    // npm sends http requests via https_proxy and https via HTTP_PROXY, so only one shared proxy keeps macOS's routing.
    !proxy ||
    proxy !== proxyUrl(fields, "HTTPS") ||
    // npm cannot match dotless hosts either, so honouring this needs a direct connection.
    fields.get("ExcludeSimpleHostnames") === "1" ||
    [...inherited, ...exceptions].some(hasUnrepresentableException)
  ) {
    return {};
  }
  const noProxy = [...inherited, ...LOOPBACK_NO_PROXY, ...exceptions.map(toNoProxyEntry)].join(",");
  return {
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENV_KEYS.some((key) => Boolean(env[key] || env[key.toLowerCase()]));
}

export const readMacosSystemProxyEnv = Effect.fn("MacosSystemProxy.readEnv")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  commandEnv: NodeJS.ProcessEnv = {},
) {
  const inherited = yield* HostProcess.Environment;
  // curl reads the lowercase form first.
  const noProxy =
    commandEnv.no_proxy || commandEnv.NO_PROXY || inherited.no_proxy || inherited.NO_PROXY || "";
  if (
    (yield* HostProcess.Platform) !== "darwin" ||
    hasProxyEnv(inherited) ||
    hasProxyEnv(commandEnv) ||
    noProxy.trim() === "*"
  ) {
    return {};
  }
  const output = yield* spawner
    .string(
      ChildProcess.make("/usr/sbin/scutil", ["--proxy"], { stdin: "ignore", stderr: "ignore" }),
    )
    .pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  return parseScutilProxy(output, noProxy);
});
