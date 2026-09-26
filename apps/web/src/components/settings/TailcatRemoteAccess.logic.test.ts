import type { TailcatRemoteAccessState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatTailcatConnectionError,
  issuedConnectionCodeStatus,
  tailcatDiagnosticsJson,
  tailcatPathKindLabel,
  tailcatPathLabel,
  tailcatRuntimeLabel,
  tailcatStatusBadgeVariant,
  tailcatStatusLabel,
} from "./TailcatRemoteAccess.logic";

const ADDRESS = `tc${"a".repeat(40)}`;

describe("issuedConnectionCodeStatus", () => {
  const live = { expiresAtMs: 2_000, nowMs: 1_000 };

  it("stays live until the pairing window has opened and closed again", () => {
    expect(
      issuedConnectionCodeStatus({ ...live, pairingWindowOpened: false, pairingOpen: false }),
    ).toBe("live");
    expect(
      issuedConnectionCodeStatus({ ...live, pairingWindowOpened: true, pairingOpen: true }),
    ).toBe("live");
    expect(
      issuedConnectionCodeStatus({ ...live, pairingWindowOpened: true, pairingOpen: false }),
    ).toBe("redeemed");
  });

  it("reports expiry first, since the window also closes when the code lapses", () => {
    expect(
      issuedConnectionCodeStatus({
        expiresAtMs: 2_000,
        nowMs: 2_000,
        pairingWindowOpened: true,
        pairingOpen: false,
      }),
    ).toBe("expired");
  });
});

describe("tailcat labels", () => {
  it("labels the measured path", () => {
    const measuredAt = "2026-09-03T12:00:00.000Z";
    expect(tailcatPathLabel(null)).toBe("Tailcat");
    expect(tailcatPathLabel({ kind: "unknown", via: null, latencyMs: null, measuredAt })).toBe(
      "Tailcat",
    );
    expect(tailcatPathLabel({ kind: "direct", via: null, latencyMs: 12, measuredAt })).toBe(
      "Tailcat · Direct",
    );
    expect(tailcatPathLabel({ kind: "relay", via: "fra", latencyMs: 80, measuredAt })).toBe(
      "Tailcat · Relay (via fra)",
    );
    expect(tailcatPathLabel({ kind: "relay", via: null, latencyMs: 80, measuredAt })).toBe(
      "Tailcat · Relay",
    );
    expect(tailcatPathKindLabel({ kind: "unknown", via: null, latencyMs: null, measuredAt })).toBe(
      "Unknown",
    );
  });

  it("maps serve status to text and badge tone", () => {
    expect(tailcatStatusLabel("ready")).toBe("Ready");
    expect(tailcatStatusBadgeVariant("ready")).toBe("success");
    expect(tailcatStatusBadgeVariant("restarting")).toBe("warning");
    expect(tailcatStatusBadgeVariant("error")).toBe("error");
    expect(tailcatStatusBadgeVariant("unavailable")).toBe("outline");
  });

  it("describes the runtime and fingerprints node keys", () => {
    expect(tailcatRuntimeLabel(null)).toBeNull();
    expect(
      tailcatRuntimeLabel({
        executablePath: "/x",
        source: "bundled",
        version: "0.5.0",
        pinnedVersion: "0.5.0",
      }),
    ).toBe("bundled 0.5.0");
  });
});

describe("formatTailcatConnectionError", () => {
  it("strips IPC and failure-code prefixes", () => {
    expect(
      formatTailcatConnectionError(
        new Error(
          "Error invoking remote method 'desktop:ensure-tailcat-environment': Error: [tailcat:remote-unavailable] The T3 server did not answer.",
        ),
        "fallback",
      ),
    ).toBe("The T3 server did not answer.");
    expect(formatTailcatConnectionError(new Error("   "), "fallback")).toBe("fallback");
    expect(formatTailcatConnectionError(42, "fallback")).toBe("fallback");
  });
});

describe("tailcatDiagnosticsJson", () => {
  it("serialises the whole state for support", () => {
    const state: TailcatRemoteAccessState = {
      enabled: true,
      status: "ready",
      address: ADDRESS,
      remotePort: 3773,
      pairingOpen: false,
      trustedPeers: [],
      runtime: null,
      identityFingerprint: "ab:cd",
      lastError: null,
      updatedAt: "2026-09-03T12:00:00.000Z",
    };
    expect(JSON.parse(tailcatDiagnosticsJson(state))).toEqual(state);
  });
});
