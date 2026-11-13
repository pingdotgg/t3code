const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

const hasValue = (value: string | undefined) => (value?.trim() ?? "") !== "";

const sameName = (platform: NodeJS.Platform) => (left: string, right: string) =>
  platform === "win32" ? left.toUpperCase() === right.toUpperCase() : left === right;

/** The variable T3 changed for the app-server, and the value agent shells should see instead. */
export interface CodexShellNoProxy {
  readonly name: string;
  readonly value: string;
}

/**
 * Codex sends requests to T3's loopback MCP endpoint through the HTTP proxy unless its own
 * NO_PROXY exempts loopback. Returns the one variable to change in the app-server's environment
 * and, because agent shells inherit that environment, what they had before.
 */
export const codexLoopbackProxyBypass = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { readonly env: NodeJS.ProcessEnv; readonly shell: CodexShellNoProxy | undefined } => {
  const unchanged = { env: {}, shell: undefined };
  const defined = (name: string) =>
    Object.keys(environment).find(
      (key) => sameName(platform)(key, name) && environment[key] !== undefined,
    );
  // Codex reads NO_PROXY, even when it is empty, and no_proxy only when NO_PROXY is unset.
  const name = defined("NO_PROXY") ?? defined("no_proxy") ?? "NO_PROXY";
  const original = environment[name];
  // Only macOS Codex is known to use a system proxy without honoring its loopback exceptions.
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
    shell: { name, value: original ?? "" },
  };
};

/**
 * Thread config that gives shells the variable as it was. Thread config outranks every config
 * file, so a variable Codex's effective config already sets for shells is left to that config.
 */
export const codexShellNoProxyConfig = (
  shell: CodexShellNoProxy,
  configuredShellVariables: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> =>
  configuredShellVariables.some((key) => sameName(platform)(key, shell.name))
    ? {}
    : { [`shell_environment_policy.set.${shell.name}`]: shell.value };
