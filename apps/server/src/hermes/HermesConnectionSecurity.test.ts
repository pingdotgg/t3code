import { describe, expect, it } from "vite-plus/test";

import {
  assessHermesConnectionSecurity,
  sanitizeHermesEndpoint,
} from "./HermesConnectionSecurity.ts";

const fingerprint = "ab:".repeat(31) + "ab";

const assess = (overrides: Partial<Parameters<typeof assessHermesConnectionSecurity>[0]> = {}) =>
  assessHermesConnectionSecurity({
    endpoint: "ws://127.0.0.1:9119/api/ws",
    gatewayToken: "local-token",
    remoteGloballyEnabled: false,
    remoteInstanceEnabled: false,
    remotePairingToken: undefined,
    remoteTlsCertificateSha256: undefined,
    ...overrides,
  });

describe("Hermes connection security", () => {
  it("preserves authenticated loopback ws behavior", () => {
    expect(assess()).toMatchObject({
      status: "ready",
      scope: "loopback",
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "local-token",
    });
  });

  it.each([
    "http://gateway.example.com/api/ws",
    "https://gateway.example.com/api/ws",
    "ws://gateway.example.com/api/ws",
    "wss://user:secret@gateway.example.com/api/ws",
    "wss://gateway.example.com/api/ws?TOKEN=secret",
  ])("rejects an insecure or credential-bearing remote endpoint: %s", (endpoint) => {
    expect(
      assess({
        endpoint,
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
      }),
    ).toMatchObject({ status: "blocked", code: "invalid_endpoint" });
  });

  it("requires independent global and instance remote opt-ins", () => {
    expect(assess({ endpoint: "wss://gateway.example.com/api/ws" })).toMatchObject({
      status: "blocked",
      code: "remote_disabled",
    });
    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
      }),
    ).toMatchObject({ status: "blocked", code: "remote_instance_disabled" });
  });

  it("requires dedicated pairing and explicit certificate trust material", () => {
    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
      }),
    ).toMatchObject({ status: "blocked", code: "remote_pairing_required" });

    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
        remotePairingToken: "local-token",
      }),
    ).toMatchObject({ status: "blocked", code: "remote_credential_reuse" });

    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
        remotePairingToken: "dedicated-pairing-token",
        remoteTlsCertificateSha256: "not-a-fingerprint",
      }),
    ).toMatchObject({ status: "blocked", code: "remote_trust_required" });
  });

  it("reports remote unsupported before creating a transport even when fully configured", () => {
    const result = assess({
      endpoint: "wss://gateway.example.com/api/ws?tenant=private",
      remoteGloballyEnabled: true,
      remoteInstanceEnabled: true,
      remotePairingToken: "dedicated-pairing-token",
      remoteTlsCertificateSha256: fingerprint,
    });

    expect(result).toMatchObject({
      status: "unsupported",
      code: "remote_verification_unsupported",
      diagnosticEndpoint: "wss://gateway.example.com/api/ws?tenant=%3Credacted%3E",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("dedicated-pairing-token");
    expect(JSON.stringify(result)).not.toContain(fingerprint);
  });

  it("sanitizes all query values, userinfo, and fragments in diagnostics", () => {
    const sanitized = sanitizeHermesEndpoint(
      "wss://user:password@gateway.example.com/api/ws?token=secret&workspace=private#fragment",
    );
    expect(sanitized).toBe(
      "wss://gateway.example.com/api/ws?token=%3Credacted%3E&workspace=%3Credacted%3E",
    );
  });
});
