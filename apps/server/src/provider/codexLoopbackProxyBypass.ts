import { parse as parseToml } from "smol-toml";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasValue = (value: string | undefined) => (value?.trim() ?? "") !== "";

const configuredShellVariables = (codexConfig: string) => {
  try {
    const policy = parseToml(codexConfig).shell_environment_policy;
    const set = isRecord(policy) ? policy.set : undefined;
    return isRecord(set) ? Object.keys(set) : [];
  } catch {
    // Codex refuses to start on a config it cannot parse.
    return [];
  }
};

/**
 * Codex sends requests to T3's loopback MCP endpoint through the HTTP proxy unless its own
 * NO_PROXY exempts loopback. Returns the one variable to change in the app-server's environment,
 * and the `-c` arguments that hand agent shells that variable back as T3's environment had it.
 */
export const codexLoopbackProxyBypass = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The text of Codex's config.toml, whose shell variables must keep winning. */
  readonly codexConfig: string;
}): { readonly env: NodeJS.ProcessEnv; readonly args: ReadonlyArray<string> } => {
  const { environment, platform } = input;
  const unchanged = { env: {}, args: [] };
  const isWindows = platform === "win32";
  const sameName = (left: string, right: string) =>
    isWindows ? left.toUpperCase() === right.toUpperCase() : left === right;
  const defined = (name: string) =>
    Object.keys(environment).find((key) => sameName(key, name) && environment[key] !== undefined);
  const shellVariables = configuredShellVariables(input.codexConfig);
  const configured = (name: string) => shellVariables.find((key) => sameName(key, name));

  // Codex reads NO_PROXY, even when it is empty, and no_proxy only when NO_PROXY is unset.
  // With neither set, a spelling the user's config gives shells keeps the new one out of them.
  const name =
    defined("NO_PROXY") ??
    defined("no_proxy") ??
    configured("NO_PROXY") ??
    configured("no_proxy") ??
    "NO_PROXY";
  const original = environment[name];
  // Windows Codex reads the registry's bypass list only while NO_PROXY is empty.
  if (isWindows && !hasValue(original)) return unchanged;
  // Linux has no system proxy, so without proxy variables Codex already connects directly.
  const usesEnvironmentProxy = Object.entries(environment).some(
    ([key, value]) => /_proxy$/i.test(key) && hasValue(value),
  );
  if (platform !== "darwin" && !usesEnvironmentProxy) return unchanged;

  const hosts = (original ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
  if (hosts.includes("*") || LOOPBACK_HOSTS.every((host) => hosts.includes(host))) {
    return unchanged;
  }

  return {
    env: { [name]: [...new Set([...hosts, ...LOOPBACK_HOSTS])].join(",") },
    // `-c` outranks config.toml, so a variable the user's config sets is left to that config.
    args:
      configured(name) === undefined
        ? ["-c", `shell_environment_policy.set.${name}=${JSON.stringify(original ?? "")}`]
        : [],
  };
};
