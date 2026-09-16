import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { buildOpenCodeSdkClientConfig } from "./opencodeRuntime.ts";

const WINDOWS_DIRECTORY = "C:\\Users\\someone\\code\\project";

describe("buildOpenCodeSdkClientConfig", () => {
  it("omits the directory for an external server on another host", () => {
    const config = buildOpenCodeSdkClientConfig({
      baseUrl: "http://10.0.0.5:4096",
      directory: WINDOWS_DIRECTORY,
      external: true,
    });

    NodeAssert.equal("directory" in config, false);
    NodeAssert.equal(config.baseUrl, "http://10.0.0.5:4096");
  });

  it("keeps the directory for a managed server", () => {
    const config = buildOpenCodeSdkClientConfig({
      baseUrl: "http://127.0.0.1:51234",
      directory: WINDOWS_DIRECTORY,
      external: false,
    });

    NodeAssert.equal(config.directory, WINDOWS_DIRECTORY);
  });

  it("keeps the directory for an external server on this machine", () => {
    for (const baseUrl of [
      "http://localhost:4096",
      "http://LOCALHOST:4096",
      // A fully qualified `localhost` keeps its root label through URL parsing.
      "http://localhost.:4096",
      // RFC 6761 reserves the whole `.localhost` tree for loopback.
      "http://name.localhost:4096",
      "http://foo.bar.localhost:4096",
      "http://127.0.0.1:4096",
      // Shorthand and trailing-dot IPv4 both canonicalise to 127.0.0.1.
      "http://127.1:4096",
      "http://127.0.0.1.:4096",
      "http://127.255.255.254:4096",
      "http://[::1]:4096",
      // IPv4-mapped loopback, which serialises as [::ffff:7f00:1].
      "http://[::ffff:127.0.0.1]:4096",
      "http://0.0.0.0:4096",
      "http://[::]:4096",
    ]) {
      const config = buildOpenCodeSdkClientConfig({
        baseUrl,
        directory: WINDOWS_DIRECTORY,
        external: true,
      });

      NodeAssert.equal(config.directory, WINDOWS_DIRECTORY, `expected directory for ${baseUrl}`);
    }
  });

  it("treats a domain that merely looks like a loopback address as remote", () => {
    // `127.example.com` is somebody else's server. Reading the leading `127.` as an
    // address is what sends a local Windows path to it.
    for (const baseUrl of [
      "http://127.example.com:4096",
      "http://localhost.example.com:4096",
      "http://notlocalhost:4096",
      "http://127.0.0.1.example.com:4096",
    ]) {
      const config = buildOpenCodeSdkClientConfig({
        baseUrl,
        directory: WINDOWS_DIRECTORY,
        external: true,
      });

      NodeAssert.equal("directory" in config, false, `expected no directory for ${baseUrl}`);
    }
  });

  it("keeps the directory when the base URL cannot be parsed", () => {
    const config = buildOpenCodeSdkClientConfig({
      baseUrl: "not a url",
      directory: WINDOWS_DIRECTORY,
      external: true,
    });

    NodeAssert.equal(config.directory, WINDOWS_DIRECTORY);
  });

  it("still sends the authorization header when the directory is dropped", () => {
    const config = buildOpenCodeSdkClientConfig({
      baseUrl: "http://build-server.internal:4096",
      directory: WINDOWS_DIRECTORY,
      external: true,
      serverPassword: "hunter2",
    });

    NodeAssert.equal("directory" in config, false);
    NodeAssert.equal(
      config.headers?.Authorization,
      `Basic ${Buffer.from("opencode:hunter2", "utf8").toString("base64")}`,
    );
  });
});
