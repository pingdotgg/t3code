import type { ServerRemoteAccess } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveRemoteConnectionDetails } from "./remoteAccess";

function createRemoteAccess(overrides?: Partial<ServerRemoteAccess>): ServerRemoteAccess {
  return {
    enabled: true,
    host: "192.168.1.42",
    port: 3773,
    authToken: "secret-token",
    ...overrides,
  };
}

describe("resolveRemoteConnectionDetails", () => {
  it("builds a connect URL and app deep link for explicit LAN hosts", () => {
    const result = resolveRemoteConnectionDetails(createRemoteAccess());

    expect(result).toEqual({
      listeningUrl: "http://192.168.1.42:3773",
      connectUrl: "http://192.168.1.42:3773",
      appConnectionUrl:
        "t3remote://connect?serverUrl=http%3A%2F%2F192.168.1.42%3A3773&authToken=secret-token",
    });
  });

  it("prefers the current browser hostname when it is already a reachable remote host", () => {
    const result = resolveRemoteConnectionDetails(
      createRemoteAccess({
        host: "0.0.0.0",
      }),
      "100.88.77.66",
    );

    expect(result).toEqual({
      listeningUrl: "http://0.0.0.0:3773",
      connectUrl: "http://100.88.77.66:3773",
      appConnectionUrl:
        "t3remote://connect?serverUrl=http%3A%2F%2F100.88.77.66%3A3773&authToken=secret-token",
    });
  });

  it("refuses to advertise loopback or unspecified hosts as remote connect URLs", () => {
    const result = resolveRemoteConnectionDetails(
      createRemoteAccess({
        host: "0.0.0.0",
      }),
      "localhost",
    );

    expect(result).toEqual({
      listeningUrl: "http://0.0.0.0:3773",
      connectUrl: null,
      appConnectionUrl: null,
    });
  });

  it("returns null URLs when remote access is disabled", () => {
    const result = resolveRemoteConnectionDetails({
      enabled: false,
      port: 3773,
    });

    expect(result).toEqual({
      listeningUrl: null,
      connectUrl: null,
      appConnectionUrl: null,
    });
  });
});
