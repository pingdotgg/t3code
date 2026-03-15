import { describe, expect, it } from "vitest";

import {
  buildRemoteConnectUrl,
  detectPreferredRemoteHost,
  formatRemoteStartupMessage,
  isTailscaleAddress,
} from "./remote-access";

describe("remote-access", () => {
  it("detects tailscale ipv4 addresses", () => {
    expect(isTailscaleAddress("100.88.10.4")).toBe(true);
    expect(isTailscaleAddress("192.168.1.20")).toBe(false);
  });

  it("prefers an explicit non-wildcard host", () => {
    expect(
      detectPreferredRemoteHost("100.88.10.4", {
        eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "", cidr: null }],
      }),
    ).toBe("100.88.10.4");
  });

  it("prefers tailscale addresses when binding wildcard hosts", () => {
    expect(
      detectPreferredRemoteHost("0.0.0.0", {
        eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "", cidr: null }],
        tailscale0: [{ address: "100.88.10.4", family: "IPv4", internal: false, netmask: "255.255.255.255", mac: "", cidr: null }],
      }),
    ).toBe("100.88.10.4");
  });

  it("falls back to the first non-internal address when tailscale is unavailable", () => {
    expect(
      detectPreferredRemoteHost("0.0.0.0", {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "", cidr: "127.0.0.1/8" }],
        eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "", cidr: null }],
      }),
    ).toBe("192.168.1.20");
  });

  it("builds a desktop-ready remote url with an optional token", () => {
    expect(
      buildRemoteConnectUrl(
        {
          host: "0.0.0.0",
          port: 3773,
          authToken: "secret",
        },
        {
          tailscale0: [{ address: "100.88.10.4", family: "IPv4", internal: false, netmask: "255.255.255.255", mac: "", cidr: null }],
        },
      ),
    ).toBe("http://100.88.10.4:3773/?token=secret");
  });

  it("builds a desktop-ready remote url without a token", () => {
    expect(
      buildRemoteConnectUrl(
        {
          host: "0.0.0.0",
          port: 3773,
          authToken: undefined,
        },
        {
          tailscale0: [{ address: "100.88.10.4", family: "IPv4", internal: false, netmask: "255.255.255.255", mac: "", cidr: null }],
        },
      ),
    ).toBe("http://100.88.10.4:3773/");
  });

  it("formats a clean startup message when a remote url is available", () => {
    expect(
      formatRemoteStartupMessage({
        connectUrl: "http://100.88.10.4:3773/",
        port: 3773,
      }),
    ).toContain("Paste this into the desktop app's Connection URL field:");
  });

  it("formats a fallback startup message when no remote host can be detected", () => {
    expect(
      formatRemoteStartupMessage({
        connectUrl: null,
        port: 4010,
      }),
    ).toContain("http://<reachable-host>:4010/");
  });
});
