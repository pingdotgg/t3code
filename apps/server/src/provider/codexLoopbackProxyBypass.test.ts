import { assert, it } from "@effect/vitest";

import { codexLoopbackProxyBypass } from "./codexLoopbackProxyBypass.ts";

const PROXY = "http://proxy.corp.example:8080";
const LOOPBACK = "127.0.0.1,localhost,::1";
const shellGets = (name: string, value: string) => [
  "-c",
  `shell_environment_policy.set.${name}=${JSON.stringify(value)}`,
];

it.each([
  {
    name: "extends only NO_PROXY when both spellings are set, and shells keep the original",
    platform: "linux",
    environment: { HTTP_PROXY: PROXY, NO_PROXY: "intranet.example", no_proxy: "remote.example" },
    env: { NO_PROXY: `intranet.example,${LOOPBACK}` },
    args: shellGets("NO_PROXY", "intranet.example"),
  },
  {
    name: "extends an empty NO_PROXY, which Codex reads instead of no_proxy",
    platform: "linux",
    environment: { HTTP_PROXY: PROXY, NO_PROXY: "", no_proxy: "intranet.example" },
    env: { NO_PROXY: LOOPBACK },
    args: shellGets("NO_PROXY", ""),
  },
  {
    name: "extends no_proxy when it is the only spelling, without creating NO_PROXY",
    platform: "linux",
    environment: { https_proxy: PROXY, no_proxy: "remote.example" },
    env: { no_proxy: `remote.example,${LOOPBACK}` },
    args: shellGets("no_proxy", "remote.example"),
  },
  {
    name: "exempts loopback from a macOS system proxy and blanks it for shells",
    platform: "darwin",
    environment: {},
    env: { NO_PROXY: LOOPBACK },
    args: shellGets("NO_PROXY", ""),
  },
  {
    name: "leaves a shell NO_PROXY from the user's Codex config alone, with no other spelling",
    platform: "darwin",
    environment: {},
    codexConfig: '[shell_environment_policy.set]\nNO_PROXY = ""\n',
    env: { NO_PROXY: LOOPBACK },
    args: [],
  },
  {
    name: "uses the spelling the user's Codex config already gives shells",
    platform: "darwin",
    environment: {},
    codexConfig: '[shell_environment_policy]\nset = { no_proxy = "intranet.example" }\n',
    env: { no_proxy: LOOPBACK },
    args: [],
  },
  {
    name: "ignores no_proxy mentioned outside shell_environment_policy.set",
    platform: "darwin",
    environment: {},
    codexConfig:
      '# no_proxy is not configured\n[shell_environment_policy]\nexclude = ["no_proxy"]\n',
    env: { NO_PROXY: LOOPBACK },
    args: shellGets("NO_PROXY", ""),
  },
  {
    name: "keeps a wildcard as the user wrote it",
    platform: "linux",
    environment: { HTTPS_PROXY: PROXY, NO_PROXY: "*" },
    env: {},
    args: [],
  },
  {
    name: "leaves Linux without proxy variables unchanged",
    platform: "linux",
    environment: { NO_PROXY: "" },
    env: {},
    args: [],
  },
  {
    name: "keeps the Windows registry bypass list in charge when NO_PROXY is unset",
    platform: "win32",
    environment: { https_proxy: PROXY },
    env: {},
    args: [],
  },
  {
    name: "extends a Windows NO_PROXY under the name the user gave it",
    platform: "win32",
    environment: { https_proxy: PROXY, No_Proxy: "intranet.example" },
    env: { No_Proxy: `intranet.example,${LOOPBACK}` },
    args: shellGets("No_Proxy", "intranet.example"),
  },
] satisfies ReadonlyArray<{
  name: string;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  codexConfig?: string;
  env: NodeJS.ProcessEnv;
  args: ReadonlyArray<string>;
}>)("$name", ({ platform, environment, codexConfig = "", env, args }) => {
  assert.deepStrictEqual(codexLoopbackProxyBypass({ environment, platform, codexConfig }), {
    env,
    args,
  });
});
