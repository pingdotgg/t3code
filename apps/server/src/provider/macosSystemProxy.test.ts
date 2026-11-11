import { assert, describe, it } from "@effect/vitest";

import { parseScutilProxy } from "./macosSystemProxy.ts";

const dictionary = (...lines: ReadonlyArray<string>) =>
  ["<dictionary> {", ...lines.map((line) => `  ${line}`), "}", ""].join("\n");

describe("parseScutilProxy", () => {
  it("ignores disabled, incomplete, SOCKS and PAC proxies", () => {
    assert.deepStrictEqual(
      parseScutilProxy(
        dictionary(
          "HTTPEnable : 0",
          "HTTPProxy : 10.0.0.1",
          "HTTPPort : 3128",
          "HTTPSEnable : 1",
          "HTTPSProxy : 10.0.0.1",
          "ProxyAutoConfigEnable : 1",
          "ProxyAutoConfigURLString : http://wpad/proxy.pac",
          "SOCKSEnable : 1",
          "SOCKSPort : 1080",
          "SOCKSProxy : 10.0.0.1",
        ),
      ),
      {},
    );
    assert.deepStrictEqual(parseScutilProxy(""), {});
  });

  it.each([
    {
      name: "an IP range exception",
      lines: ["ExceptionsList : <array> {", "  0 : 192.168.0.0/16", "}"],
      noProxy: "",
    },
    {
      name: "a wildcard IP exception",
      lines: ["ExceptionsList : <array> {", "  0 : 10.*", "}"],
      noProxy: "",
    },
    { name: "an IP range in NO_PROXY", lines: [], noProxy: "registry.corp,127.0.0.0/8" },
    { name: "simple hostnames excluded", lines: ["ExcludeSimpleHostnames : 1"], noProxy: "" },
    { name: "an HTTPS-only proxy", lines: ["HTTPEnable : 0"], noProxy: "" },
    { name: "different HTTP and HTTPS proxies", lines: ["HTTPPort : 8080"], noProxy: "" },
  ])("keeps the direct connection with $name, which npm cannot match", ({ lines, noProxy }) => {
    const proxy = ["HTTPEnable : 1", "HTTPPort : 3128", "HTTPProxy : 10.0.0.1"];
    const httpsProxy = ["HTTPSEnable : 1", "HTTPSPort : 3128", "HTTPSProxy : 10.0.0.1"];
    assert.deepStrictEqual(
      parseScutilProxy(dictionary(...proxy, ...httpsProxy, ...lines), noProxy),
      {},
    );
  });

  it("reads only the top-level settings and merges exceptions into NO_PROXY", () => {
    assert.deepStrictEqual(
      parseScutilProxy(
        dictionary(
          "ExceptionsList : <array> {",
          "  0 : *.local",
          "  1 : 169.254/16",
          "  2 : internal.corp",
          "}",
          "HTTPEnable : 1",
          "HTTPPort : 8443",
          "HTTPProxy : fd00::1",
          "HTTPSEnable : 1",
          "HTTPSPort : 8443",
          "HTTPSProxy : fd00::1",
          "__SCOPED__ : <dictionary> {",
          "  en0 : <dictionary> {",
          "    HTTPEnable : 1",
          "    HTTPPort : 9999",
          "    HTTPProxy : 10.9.9.9",
          "  }",
          "}",
        ),
        "registry.corp, ",
      ),
      {
        HTTP_PROXY: "http://[fd00::1]:8443",
        http_proxy: "http://[fd00::1]:8443",
        HTTPS_PROXY: "http://[fd00::1]:8443",
        https_proxy: "http://[fd00::1]:8443",
        NO_PROXY: "registry.corp,localhost,127.0.0.1,::1,[::1],.local,169.254.0.0/16,internal.corp",
        no_proxy: "registry.corp,localhost,127.0.0.1,::1,[::1],.local,169.254.0.0/16,internal.corp",
      },
    );
  });
});
