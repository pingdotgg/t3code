import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentVoiceHttpError,
  REALTIME_VOICES,
  RealtimeVoice,
  VoiceCredentialMutation,
  VoiceCredentialStatus,
  VoiceOpenAiApiKey,
  VoiceRealtimeClientSecret,
  VoiceRealtimeClientSecretRequest,
} from "./voice.ts";

const decodeVoice = Schema.decodeUnknownSync(RealtimeVoice);
const decodeApiKey = Schema.decodeUnknownSync(VoiceOpenAiApiKey);
const decodeMutation = Schema.decodeUnknownSync(VoiceCredentialMutation);
const decodeCredentialStatus = Schema.decodeUnknownSync(VoiceCredentialStatus);
const decodeClientSecret = Schema.decodeUnknownSync(VoiceRealtimeClientSecret);
const decodeClientSecretRequest = Schema.decodeUnknownSync(VoiceRealtimeClientSecretRequest);
const decodeVoiceHttpError = Schema.decodeUnknownSync(EnvironmentVoiceHttpError);

describe("voice contracts", () => {
  it("accepts every supported Realtime voice and rejects unknown voices", () => {
    expect(REALTIME_VOICES.map((voice) => decodeVoice(voice))).toEqual([
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "sage",
      "shimmer",
      "verse",
      "marin",
      "cedar",
    ]);
    expect(() => decodeVoice("unknown")).toThrow();
  });

  it("normalizes and bounds the server credential", () => {
    expect(decodeApiKey("  sk-test  ")).toBe("sk-test");
    expect(() => decodeApiKey("   ")).toThrow();
    expect(() => decodeApiKey("x".repeat(4_097))).toThrow();
  });

  it("keeps credential removal as an explicit reverse operation", () => {
    expect(decodeMutation({ action: "set", apiKey: " sk-test " })).toEqual({
      action: "set",
      apiKey: "sk-test",
    });
    expect(decodeMutation({ action: "remove" })).toEqual({ action: "remove" });
    expect(decodeMutation({ action: "remove", apiKey: "sk-test" })).toEqual({
      action: "remove",
    });
  });

  it("rejects incoherent credential status states", () => {
    expect(decodeCredentialStatus({ configured: false, source: null })).toEqual({
      configured: false,
      source: null,
    });
    expect(decodeCredentialStatus({ configured: true, source: "stored" })).toEqual({
      configured: true,
      source: "stored",
    });
    expect(() => decodeCredentialStatus({ configured: false, source: "stored" })).toThrow();
    expect(() => decodeCredentialStatus({ configured: true, source: null })).toThrow();
  });

  it("defaults the mint request at the server while rejecting unknown voice input", () => {
    expect(decodeClientSecretRequest({})).toEqual({});
    expect(decodeClientSecretRequest({ voice: "cedar" })).toEqual({
      voice: "cedar",
    });
    expect(() => decodeClientSecretRequest({ voice: "robot" })).toThrow();
  });

  it("requires a complete, unexpired-shaped client-secret response", () => {
    expect(
      decodeClientSecret({
        clientSecret: "ek_test",
        expiresAt: 1,
        sessionId: "sess_test",
      }),
    ).toEqual({ clientSecret: "ek_test", expiresAt: 1, sessionId: "sess_test" });
    expect(() => decodeClientSecret({ clientSecret: "", expiresAt: 0, sessionId: "" })).toThrow();
  });

  it("decodes only declared public voice error shapes", () => {
    expect(
      decodeVoiceHttpError({
        _tag: "EnvironmentVoiceRateLimitedError",
        code: "rate_limited",
        reason: "upstream_rate_limit",
        retryAfterSeconds: 3,
        traceId: "trace-1",
      }),
    ).toMatchObject({ reason: "upstream_rate_limit", retryAfterSeconds: 3 });
    expect(() =>
      decodeVoiceHttpError({
        _tag: "EnvironmentVoiceUpstreamError",
        code: "voice_upstream_error",
        reason: "raw_openai_message",
        traceId: "trace-1",
      }),
    ).toThrow();
  });
});
