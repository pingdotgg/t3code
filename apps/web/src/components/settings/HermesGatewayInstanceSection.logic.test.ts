import { describe, expect, it } from "vite-plus/test";

import {
  defaultHermesConnectorUrl,
  formatHermesLastConnected,
  hermesGatewayStatusLabel,
  messageFromUnknownError,
  shouldApplyHermesConnectorStatusUrl,
} from "./HermesGatewayInstanceSection.logic";

describe("Hermes gateway settings logic", () => {
  it("uses the current origin with the gateway WebSocket route", () => {
    expect(defaultHermesConnectorUrl("https://siva.davis7.space:3774/settings")).toBe(
      "https://siva.davis7.space:3774/api/hermes-gateway/ws",
    );
  });

  it("provides useful labels for every connection state", () => {
    expect(
      ["offline", "connecting", "connected", "upgrade-required", "revoked"].map((status) =>
        hermesGatewayStatusLabel(status as never),
      ),
    ).toEqual(["Offline", "Connecting", "Connected", "Upgrade required", "Revoked"]);
  });

  it("keeps invalid server timestamps readable and extracts structured messages", () => {
    expect(formatHermesLastConnected(null)).toBe("Never");
    expect(formatHermesLastConnected("not-a-date")).toBe("not-a-date");
    expect(messageFromUnknownError({ message: "Nickname is already used." })).toBe(
      "Nickname is already used.",
    );
  });

  it("does not replace an in-progress connector URL edit during status polling", () => {
    expect(shouldApplyHermesConnectorStatusUrl(false)).toBe(true);
    expect(shouldApplyHermesConnectorStatusUrl(true)).toBe(false);
  });
});
