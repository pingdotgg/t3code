import { EnvironmentId, type TailcatRemoteAccessState } from "@t3tools/contracts";
import {
  encodeFederationPeerCode,
  encodeTailcatConnectionCode,
} from "@t3tools/shared/t3ConnectionCode";
import { describe, expect, it } from "vite-plus/test";

import {
  formatTailcatConnectionError,
  parseTailcatConnectionCodePreview,
  tailcatDiagnosticsJson,
  tailcatPathKindLabel,
  tailcatPathLabel,
  tailcatRuntimeLabel,
  tailcatStatusBadgeVariant,
  tailcatStatusLabel,
} from "./TailcatRemoteAccess.logic";

const ADDRESS = `tc${"a".repeat(40)}`;

const tailcatCode = (expiresAt: string) =>
  encodeTailcatConnectionCode({
    v: 1,
    transport: "tailcat",
    address: ADDRESS,
    port: 3773,
    environmentId: EnvironmentId.make("env-studio"),
    name: "Studio",
    serverVersion: "0.9.0",
    pairingToken: "one-time",
    expiresAt,
  });

describe("parseTailcatConnectionCodePreview", () => {
  it("previews the environment behind a valid code with its expiry", () => {
    const code = tailcatCode("2026-09-03T12:05:00.000Z");
    expect(parseTailcatConnectionCodePreview(`  ${code}\n`)).toEqual({
      kind: "valid",
      payload: expect.objectContaining({ address: ADDRESS, port: 3773, name: "Studio" }),
      expiresAtMs: Date.parse("2026-09-03T12:05:00.000Z"),
    });
  });

  it("redirects peer codes and rejects other input", () => {
    const peerCode = encodeFederationPeerCode({
      v: 1,
      kind: "peer",
      protocolVersion: 1,
      environmentId: EnvironmentId.make("env-2"),
      publicKey: "pem",
      label: "Peer",
      transport: { tailcat: { address: ADDRESS, port: 3773 } },
      token: "one-time",
      scopes: ["environment.read"],
      expiresAt: "2026-09-03T12:05:00.000Z",
    });
    expect(parseTailcatConnectionCodePreview(peerCode)).toMatchObject({ kind: "peer-code" });
    expect(parseTailcatConnectionCodePreview("")).toEqual({ kind: "empty" });
    expect(parseTailcatConnectionCodePreview("https://example.com/pair#token=x")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("t3c://tailcat/"),
    });
    expect(parseTailcatConnectionCodePreview("t3c://tailcat/%%%")).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("incomplete or damaged"),
    });
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
