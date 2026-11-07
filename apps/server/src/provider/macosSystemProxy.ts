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

// macOS writes `*.local` and `169.254/16`; curl matches `.local` and full CIDRs (npm ignores CIDRs).
function toNoProxyEntry(exception: string): string {
  if (exception.startsWith("*.")) {
    return exception.slice(1);
  }
  const cidr = /^(\d+(?:\.\d+){0,3})\/(\d+)$/.exec(exception);
  if (!cidr) {
    return exception;
  }
  const octets = cidr[1]!.split(".");
  while (octets.length < 4) octets.push("0");
  return `${octets.join(".")}/${cidr[2]}`;
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

  const http = proxyUrl(fields, "HTTP");
  const https = proxyUrl(fields, "HTTPS");
  if (!http && !https) {
    return {};
  }
  const noProxy = [
    ...inheritedNoProxy.split(",").flatMap((entry) => entry.trim() || []),
    ...LOOPBACK_NO_PROXY,
    ...exceptions.map(toNoProxyEntry),
  ].join(",");
  return {
    ...(http ? { HTTP_PROXY: http, http_proxy: http } : {}),
    ...(https ? { HTTPS_PROXY: https, https_proxy: https } : {}),
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
