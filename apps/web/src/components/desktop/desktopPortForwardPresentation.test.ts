import { describe, expect, it } from "vite-plus/test";

import { portForwardConnectionSummary } from "./desktopPortForwardPresentation";

describe("desktop port-forward presentation", () => {
  it("distinguishes an idle listener from a pending connection", () => {
    expect(
      portForwardConnectionSummary({
        activeConnections: 0,
        connectingConnections: 0,
        lastError: null,
      }),
    ).toBe("Listening");
    expect(
      portForwardConnectionSummary({
        activeConnections: 0,
        connectingConnections: 1,
        lastError: null,
      }),
    ).toBe("1 connecting");
  });

  it("only calls an established bridge connected", () => {
    expect(
      portForwardConnectionSummary({
        activeConnections: 2,
        connectingConnections: 1,
        lastError: null,
      }),
    ).toBe("2 connected · 1 connecting");
  });

  it("surfaces a failed connection after its socket closes", () => {
    expect(
      portForwardConnectionSummary({
        activeConnections: 0,
        connectingConnections: 0,
        lastError: "Authorization failed.",
      }),
    ).toBe("Connection failed");
  });
});
