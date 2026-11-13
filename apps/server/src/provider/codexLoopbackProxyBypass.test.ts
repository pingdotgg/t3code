import { assert, it } from "@effect/vitest";

import { codexLoopbackProxyBypass, codexShellNoProxyConfig } from "./codexLoopbackProxyBypass.ts";

const PROXY = "http://proxy.corp.example:8080";
const LOOPBACK = "127.0.0.1,localhost,::1";

it.each([
  {
    name: "extends only NO_PROXY when both spellings are set, and shells keep the original",
    platform: "linux",
    environment: { HTTP_PROXY: PROXY, NO_PROXY: "intranet.example", no_proxy: "remote.example" },
    env: { NO_PROXY: `intranet.example,${LOOPBACK}` },
    shell: { name: "NO_PROXY", value: "intranet.example" },
  },
  {
    name: "extends an empty NO_PROXY, which Codex reads instead of no_proxy",
    platform: "linux",
    environment: { HTTP_PROXY: PROXY, NO_PROXY: "", no_proxy: "intranet.example" },
    env: { NO_PROXY: LOOPBACK },
    shell: { name: "NO_PROXY", value: "" },
  },
  {
    name: "extends no_proxy when it is the only spelling, without creating NO_PROXY",
    platform: "linux",
    environment: { https_proxy: PROXY, no_proxy: "remote.example" },
    env: { no_proxy: `remote.example,${LOOPBACK}` },
    shell: { name: "no_proxy", value: "remote.example" },
  },
  {
    name: "exempts loopback from a macOS system proxy and reports it as unset for shells",
    platform: "darwin",
    environment: {},
    env: { NO_PROXY: LOOPBACK },
    shell: { name: "NO_PROXY", value: undefined },
  },
  {
    name: "keeps a wildcard as the user wrote it",
    platform: "linux",
    environment: { HTTPS_PROXY: PROXY, NO_PROXY: "*" },
    env: {},
    shell: undefined,
  },
  {
    name: "leaves Linux without proxy variables unchanged",
    platform: "linux",
    environment: { NO_PROXY: "" },
    env: {},
    shell: undefined,
  },
  {
    name: "exempts loopback from a Windows environment proxy",
    platform: "win32",
    environment: { HTTP_PROXY: PROXY },
    env: { NO_PROXY: LOOPBACK },
    shell: { name: "NO_PROXY", value: undefined },
  },
  {
    name: "leaves a Windows registry proxy and its bypass list alone",
    platform: "win32",
    environment: {},
    env: {},
    shell: undefined,
  },
  {
    name: "extends a Windows NO_PROXY under the name the user gave it",
    platform: "win32",
    environment: { https_proxy: PROXY, No_Proxy: "intranet.example" },
    env: { No_Proxy: `intranet.example,${LOOPBACK}` },
    shell: { name: "No_Proxy", value: "intranet.example" },
  },
] satisfies ReadonlyArray<{
  name: string;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  env: NodeJS.ProcessEnv;
  shell: { name: string; value: string | undefined } | undefined;
}>)("$name", ({ platform, environment, env, shell }) => {
  assert.deepStrictEqual(codexLoopbackProxyBypass(environment, platform), { env, shell });
});

it("leaves the other spelling to shells when Codex's config sets only that one", () => {
  const shell = { name: "NO_PROXY", value: "" };
  const restore = { "shell_environment_policy.set.NO_PROXY": "" };
  const policy = { set: { no_proxy: "127.0.0.1" } };

  assert.deepStrictEqual(codexShellNoProxyConfig(shell, policy, "linux"), restore);
  assert.deepStrictEqual(codexShellNoProxyConfig(shell, policy, "win32"), {});
});

it.each([
  {
    name: "excludes it beside a configured no_proxy instead of blanking it",
    policy: { set: { no_proxy: "127.0.0.1" }, exclude: null, filters: null },
    config: { "shell_environment_policy.exclude": ["NO_PROXY"] },
  },
  {
    name: "keeps the configured excludes",
    policy: { exclude: ["AWS_*"] },
    config: { "shell_environment_policy.exclude": ["AWS_*", "NO_PROXY"] },
  },
  {
    name: "adds a filter when the config uses filters",
    policy: { filters: { "AWS_*": "exclude" } },
    config: { "shell_environment_policy.filters.NO_PROXY": "exclude" },
  },
  {
    name: "leaves a NO_PROXY the config sets",
    policy: { set: { NO_PROXY: "intranet.example" } },
    config: {},
  },
  {
    name: "changes nothing when the config could not be read",
    policy: undefined,
    config: {},
  },
])("a NO_PROXY that was unset: $name", ({ policy, config }) => {
  const shell = { name: "NO_PROXY", value: undefined };

  assert.deepStrictEqual(codexShellNoProxyConfig(shell, policy, "linux"), config);
});
