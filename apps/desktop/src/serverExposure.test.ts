import { describe, expect, it } from "vitest";

import { resolveDesktopServerExposure, resolveLanAdvertisedHost } from "./serverExposure";

describe("resolveLanAdvertisedHost", () => {
  it("prefers an explicit host override", () => {
    expect(
      resolveLanAdvertisedHost(
        {
          en0: [
            {
              address: "192.168.1.44",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "192.168.1.44/24",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
        "10.0.0.9",
      ),
    ).toBe("10.0.0.9");
  });

  it("returns the first usable non-internal IPv4 address", () => {
    expect(
      resolveLanAdvertisedHost(
        {
          lo0: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
              netmask: "255.0.0.0",
              cidr: "127.0.0.1/8",
              mac: "00:00:00:00:00:00",
            },
          ],
          en0: [
            {
              address: "192.168.1.44",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "192.168.1.44/24",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
        undefined,
      ),
    ).toBe("192.168.1.44");
  });

  it("returns null when no usable network address is available", () => {
    expect(
      resolveLanAdvertisedHost(
        {
          lo0: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
              netmask: "255.0.0.0",
              cidr: "127.0.0.1/8",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
        undefined,
      ),
    ).toBeNull();
  });
});

describe("resolveDesktopServerExposure", () => {
  it("keeps the desktop server loopback-only when local-only mode is selected", () => {
    expect(
      resolveDesktopServerExposure({
        mode: "local-only",
        port: 3773,
        networkInterfaces: {},
      }),
    ).toEqual({
      mode: "local-only",
      bindHost: "127.0.0.1",
      localHttpUrl: "http://127.0.0.1:3773",
      localWsUrl: "ws://127.0.0.1:3773",
      endpointUrl: null,
      advertisedHost: null,
    });
  });

  it("binds to all interfaces in network-accessible mode", () => {
    expect(
      resolveDesktopServerExposure({
        mode: "network-accessible",
        port: 3773,
        networkInterfaces: {
          en0: [
            {
              address: "192.168.1.44",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "192.168.1.44/24",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual({
      mode: "network-accessible",
      bindHost: "0.0.0.0",
      localHttpUrl: "http://127.0.0.1:3773",
      localWsUrl: "ws://127.0.0.1:3773",
      endpointUrl: "http://192.168.1.44:3773",
      advertisedHost: "192.168.1.44",
    });
  });

  it("stays network-accessible even when no LAN address is currently detectable", () => {
    expect(
      resolveDesktopServerExposure({
        mode: "network-accessible",
        port: 3773,
        networkInterfaces: {},
      }),
    ).toEqual({
      mode: "network-accessible",
      bindHost: "0.0.0.0",
      localHttpUrl: "http://127.0.0.1:3773",
      localWsUrl: "ws://127.0.0.1:3773",
      endpointUrl: null,
      advertisedHost: null,
    });
  });
});
