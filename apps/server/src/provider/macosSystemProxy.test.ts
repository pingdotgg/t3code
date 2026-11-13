import { assert, describe, it } from "@effect/vitest";

import { macosSystemProxyEnv } from "./macosSystemProxy.ts";

const PROXY = [
  "HTTPEnable : 1",
  "HTTPPort : 3128",
  "HTTPProxy : proxy.corp",
  "HTTPSEnable : 1",
  "HTTPSPort : 3128",
  "HTTPSProxy : proxy.corp",
];

const scutil = (...lines: ReadonlyArray<string>) =>
  ["<dictionary> {", ...lines.map((line) => `  ${line}`), "}", ""].join("\n");

const exceptions = (...hosts: ReadonlyArray<string>) => [
  "ExceptionsList : <array> {",
  ...hosts.map((host, index) => `  ${index} : ${host}`),
  "}",
];

// npm's matcher (@npmcli/agent): NO_PROXY entries are dot-separated suffixes, never ranges.
function npmBypasses(noProxy: string, hostname: string): boolean {
  const host = hostname.split(".").toReversed();
  return noProxy.split(",").some((entry) => {
    const segments = entry.split(".").filter(Boolean).toReversed();
    return segments.length > 0 && segments.every((segment, index) => host[index] === segment);
  });
}

describe("macosSystemProxyEnv", () => {
  it("maps one shared HTTP and HTTPS proxy and keeps macOS's direct hosts direct", () => {
    const env = macosSystemProxyEnv(
      scutil(
        ...exceptions("*.local", "169.254/16", "internal.corp", "fd00::5"),
        "FTPPassive : 1",
        ...PROXY,
        "__SCOPED__ : <dictionary> {",
        "  en0 : <dictionary> {",
        "    HTTPEnable : 1",
        "    HTTPPort : 9999",
        "    HTTPProxy : 10.9.9.9",
        "  }",
        "}",
      ),
      ["registry.corp"],
    );

    assert.strictEqual(env.HTTP_PROXY, "http://proxy.corp:3128");
    assert.strictEqual(env.https_proxy, "http://proxy.corp:3128");
    assert.strictEqual(env.NO_PROXY, env.no_proxy);
    const noProxy = env.NO_PROXY ?? "";
    assert.strictEqual(
      noProxy.split(",").slice(0, 10).join(","),
      "registry.corp,localhost,127.0.0.1,::1,[::1],.local,internal.corp,fd00::5,[fd00::5],0.0.0.0/1",
    );
    for (const direct of [
      "127.0.0.2",
      "169.254.10.20",
      "10.1.2.3",
      "printer.local",
      "internal.corp",
      "registry.corp",
      "[fd00::5]",
      "localhost",
    ]) {
      assert.isTrue(npmBypasses(noProxy, direct), direct);
    }
    assert.isFalse(npmBypasses(noProxy, "registry.npmjs.org"));
  });

  it("brackets an IPv6 proxy host", () => {
    assert.strictEqual(
      macosSystemProxyEnv(
        scutil(
          "HTTPEnable : 1",
          "HTTPPort : 8443",
          "HTTPProxy : fd00::1",
          "HTTPSEnable : 1",
          "HTTPSPort : 8443",
          "HTTPSProxy : fd00::1",
        ),
      ).HTTPS_PROXY,
      "http://[fd00::1]:8443",
    );
  });

  it.each([
    { name: "no proxy", lines: [] },
    { name: "a disabled proxy", lines: [...PROXY, "HTTPEnable : 0", "HTTPSEnable : 0"] },
    { name: "an HTTPS-only proxy", lines: [...PROXY, "HTTPEnable : 0"] },
    { name: "different HTTP and HTTPS proxies", lines: [...PROXY, "HTTPPort : 8080"] },
    { name: "a proxy without a port", lines: PROXY.filter((line) => !line.includes("Port")) },
    { name: "an authenticated proxy", lines: [...PROXY, "HTTPUser : julia"] },
    { name: "a PAC file", lines: [...PROXY, "ProxyAutoConfigEnable : 1"] },
    { name: "proxy auto-discovery", lines: [...PROXY, "ProxyAutoDiscoveryEnable : 1"] },
    { name: "simple hostnames excluded", lines: [...PROXY, "ExcludeSimpleHostnames : 1"] },
    { name: "a bypass-all exception", lines: [...PROXY, ...exceptions("*")] },
    { name: "an IPv6 range exception", lines: [...PROXY, ...exceptions("fe80::/10")] },
    { name: "a mid-name wildcard exception", lines: [...PROXY, ...exceptions("build*.corp")] },
  ])("sets nothing with $name", ({ lines }) => {
    assert.deepStrictEqual(macosSystemProxyEnv(scutil(...lines)), {});
  });
});
