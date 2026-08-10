import {
  AuthAccessWriteScope,
  EnvironmentId,
  type VoiceCredentialStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildVoiceEnvironmentOptions,
  classifyVoiceEnvironmentAvailability,
  describeVoiceCredentialStatus,
  isVoiceCredentialPermissionDenied,
  resolveSelectedVoiceEnvironmentId,
  resolveVoiceCredentialWriteAccess,
  voiceCredentialErrorMessage,
} from "./VoiceSettingsPanel.logic";

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("voice environment selection", () => {
  it("puts the primary environment first and keeps an explicit valid selection", () => {
    const options = buildVoiceEnvironmentOptions(environments, primaryId);
    expect(options.map((environment) => environment.environmentId)).toEqual([
      primaryId,
      relayId,
      sshId,
    ]);
    expect(resolveSelectedVoiceEnvironmentId(options, sshId, primaryId)).toBe(sshId);
  });

  it("falls back to primary, then the first available environment", () => {
    const options = buildVoiceEnvironmentOptions(environments, primaryId);
    expect(resolveSelectedVoiceEnvironmentId(options, EnvironmentId.make("gone"), primaryId)).toBe(
      primaryId,
    );
    expect(resolveSelectedVoiceEnvironmentId(options.slice(1), primaryId, primaryId)).toBe(relayId);
    expect(resolveSelectedVoiceEnvironmentId([], null, primaryId)).toBeNull();
  });
});

describe("voice environment availability", () => {
  it("requires an advertised capability before the client may probe voice endpoints", () => {
    expect(
      classifyVoiceEnvironmentAvailability({
        connectionPhase: "connected",
        hasServerConfig: true,
        supportsRealtimeVoice: false,
        hasPreparedConnection: true,
      }),
    ).toEqual({
      kind: "unsupported",
      message: "This environment does not support Realtime voice yet. Update its T3 server.",
    });
  });

  it("distinguishes loading, offline, and ready states", () => {
    expect(
      classifyVoiceEnvironmentAvailability({
        connectionPhase: "connected",
        hasServerConfig: false,
        supportsRealtimeVoice: false,
        hasPreparedConnection: false,
      }).kind,
    ).toBe("loading");
    expect(
      classifyVoiceEnvironmentAvailability({
        connectionPhase: "offline",
        hasServerConfig: true,
        supportsRealtimeVoice: true,
        hasPreparedConnection: true,
      }).kind,
    ).toBe("unavailable");
    expect(
      classifyVoiceEnvironmentAvailability({
        connectionPhase: "connected",
        hasServerConfig: true,
        supportsRealtimeVoice: true,
        hasPreparedConnection: true,
      }),
    ).toEqual({ kind: "ready" });
  });
});

describe("voice credential access and redaction", () => {
  it("gates known sessions on access:write without inventing authority when scopes are unknown", () => {
    expect(
      resolveVoiceCredentialWriteAccess({
        session: { authenticated: true, scopes: [AuthAccessWriteScope] },
        isPending: false,
      }),
    ).toBe("granted");
    expect(
      resolveVoiceCredentialWriteAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
      }),
    ).toBe("denied");
    expect(
      resolveVoiceCredentialWriteAccess({
        session: { authenticated: true },
        isPending: false,
      }),
    ).toBe("unknown");
    expect(resolveVoiceCredentialWriteAccess({ session: null, isPending: true })).toBe("pending");
    expect(resolveVoiceCredentialWriteAccess({ session: null, isPending: false })).toBe("unknown");
  });

  it("never includes upstream messages or credential material in user-facing errors", () => {
    const secret = "sk-should-never-render";
    const message = voiceCredentialErrorMessage({
      _tag: "RemoteEnvironmentAuthFetchError",
      message: `failed with ${secret}`,
      cause: secret,
    });
    expect(message).toBe(
      "T3 could not reach this environment. Check its connection and try again.",
    );
    expect(message).not.toContain(secret);
  });

  it("recognizes only typed permission denials as authoritative", () => {
    expect(isVoiceCredentialPermissionDenied({ _tag: "EnvironmentScopeRequiredError" })).toBe(true);
    expect(isVoiceCredentialPermissionDenied({ _tag: "EnvironmentOperationForbiddenError" })).toBe(
      true,
    );
    expect(isVoiceCredentialPermissionDenied({ _tag: "RemoteEnvironmentAuthFetchError" })).toBe(
      false,
    );
    expect(isVoiceCredentialPermissionDenied(new Error("forbidden"))).toBe(false);
  });

  it.each([
    [{ configured: false, source: null }, "No OpenAI API key is configured."],
    [
      { configured: true, source: "stored" },
      "A write-only OpenAI API key is stored by this environment.",
    ],
    [
      { configured: true, source: "environment" },
      "This environment is using OPENAI_API_KEY from its host process.",
    ],
  ] as const)("describes the redacted status %#", (status, expected) => {
    expect(describeVoiceCredentialStatus(status as VoiceCredentialStatus)).toBe(expected);
  });
});
