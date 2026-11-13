import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "all_proxy"];

// NO_PROXY has no portable IP range: curl and Go read CIDR, npm only matches dot-separated
// suffixes. A bypassed range or loopback address must stay direct in both, so every IPv4
// literal is: two /1 blocks (curl ignores /0) plus each possible last octet.
const IPV4_DIRECT = [
  "0.0.0.0/1",
  "128.0.0.0/1",
  ...Array.from({ length: 256 }, (_, octet) => `.${octet}`),
];
const LOOPBACK_DIRECT = ["localhost", "127.0.0.1", "::1", "[::1]"];

const IPV4_EXCEPTION = /^(?=.*\d)[\d.*]+(?:\/\d+)?$/;
const IPV6_ADDRESS = /^[0-9a-f:.]+$/i;
const HOST_NAME = /^[a-z0-9._-]+$/i;

function readScutilProxy(output: string) {
  const fields = new Map<string, string>();
  const exceptions: Array<string> = [];
  let hasDomainProxies = false;
  let depth = 0;
  let block = "";
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (text === "}") {
      depth -= 1;
      if (depth <= 1) block = "";
      continue;
    }
    hasDomainProxies ||= block === "__SUPPLEMENTAL__";
    const separator = text.indexOf(" : ");
    const key = separator === -1 ? "" : text.slice(0, separator);
    const value = separator === -1 ? "" : text.slice(separator + 3).trim();
    if (text.endsWith("{")) {
      if (depth === 1) block = key;
      depth += 1;
    } else if (depth === 1 && key) {
      fields.set(key, value);
    } else if (block === "ExceptionsList" && value) {
      exceptions.push(value);
    }
  }
  return { fields, exceptions, hasDomainProxies };
}

function proxyUrl(fields: ReadonlyMap<string, string>, scheme: "HTTP" | "HTTPS"): string | null {
  const host = fields.get(`${scheme}Proxy`) ?? "";
  const port = fields.get(`${scheme}Port`) ?? "";
  // The password of an authenticated proxy is in the keychain, out of reach.
  if (fields.get(`${scheme}Enable`) !== "1" || fields.has(`${scheme}User`) || !/^\d+$/.test(port)) {
    return null;
  }
  if (host.includes(":")) {
    return IPV6_ADDRESS.test(host) ? `http://[${host}]:${port}` : null;
  }
  return HOST_NAME.test(host) ? `http://${host}:${port}` : null;
}

/** NO_PROXY entries for one macOS exception, or null when no entry can express it. */
function noProxyEntries(exception: string): ReadonlyArray<string> | null {
  if (IPV4_EXCEPTION.test(exception)) {
    return [];
  }
  if (exception.includes(":")) {
    return IPV6_ADDRESS.test(exception) ? [exception, `[${exception}]`] : null;
  }
  const name = exception.startsWith("*.") ? exception.slice(1) : exception;
  return HOST_NAME.test(name) ? [name] : null;
}

/**
 * Maps `scutil -d --proxy` output to proxy env vars, or to nothing when the env vars would proxy a
 * request macOS sends directly. SOCKS is not used.
 */
export function macosSystemProxyEnv(
  scutilOutput: string,
  existingNoProxy: ReadonlyArray<string> = [],
): Record<string, string> {
  const { fields, exceptions, hasDomainProxies } = readScutilProxy(scutilOutput);
  const proxy = proxyUrl(fields, "HTTP");
  const exceptionEntries = exceptions.map(noProxyEntries);
  if (
    !proxy ||
    // npm sends http requests through https_proxy, so two proxies cannot keep macOS's routing.
    proxy !== proxyUrl(fields, "HTTPS") ||
    fields.get("ProxyAutoConfigEnable") === "1" ||
    fields.get("ProxyAutoDiscoveryEnable") === "1" ||
    // A VPN's per-domain proxies; one set of variables cannot route by domain.
    hasDomainProxies ||
    // No NO_PROXY entry matches every dotless host.
    fields.get("ExcludeSimpleHostnames") === "1" ||
    exceptionEntries.includes(null)
  ) {
    return {};
  }
  const noProxy = [
    ...new Set([
      ...existingNoProxy,
      ...LOOPBACK_DIRECT,
      ...exceptionEntries.flatMap((entries) => entries ?? []),
      ...IPV4_DIRECT,
    ]),
  ].join(",");
  return {
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/** Proxy env vars for a command on macOS whose environment names no proxy of its own. */
export const readMacosSystemProxyEnv = Effect.fn("MacosSystemProxy.readEnv")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  commandEnv: NodeJS.ProcessEnv = {},
) {
  if ((yield* HostProcess.Platform) !== "darwin") {
    return {};
  }
  const env = { ...(yield* HostProcess.Environment), ...commandEnv };
  const noProxy = [env.no_proxy, env.NO_PROXY]
    .flatMap((value) => (value ?? "").split(","))
    .flatMap((entry) => entry.trim() || []);
  if (
    PROXY_ENV_KEYS.some((key) => env[key] || env[key.toUpperCase()]) ||
    // npm reads its own proxy settings from the environment too.
    Object.keys(env).some((key) => /^npm_config_(https?[-_])?proxy$/i.test(key) && env[key]) ||
    noProxy.includes("*")
  ) {
    return {};
  }
  const output = yield* spawner
    .string(
      // Without -d, scutil leaves the per-domain proxies out.
      ChildProcess.make("/usr/sbin/scutil", ["-d", "--proxy"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  return macosSystemProxyEnv(output, noProxy);
});
