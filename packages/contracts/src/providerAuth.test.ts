import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PROVIDER_SIGN_IN_MODES,
  ProviderAuthError,
  ProviderAuthFailedError,
  ProviderAuthLoginInProgressError,
  ProviderAuthUnsupportedError,
  ProviderSignInEvent,
  ProviderSignInMode,
  ProviderStartSignInInput,
} from "./providerAuth.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderSignInEvent);
const encodeEvent = Schema.encodeUnknownSync(ProviderSignInEvent);
const decodeInput = Schema.decodeUnknownResult(ProviderStartSignInInput);
const decodeEventResult = Schema.decodeUnknownResult(ProviderSignInEvent);
const isAuthError = Schema.is(ProviderAuthError);
const isSignInMode = Schema.is(ProviderSignInMode);

const roundTrip = (value: unknown) => encodeEvent(decodeEvent(value));

const decodeFails = (value: unknown) => decodeEventResult(value)._tag === "Failure";

describe("ProviderSignInEvent", () => {
  it("round-trips every variant", () => {
    const variants = [
      { _tag: "started" },
      { _tag: "browserHandoff", authUrl: "https://auth.openai.com/oauth?x=1" },
      {
        _tag: "deviceCode",
        userCode: "ABCD-EFGHI",
        verificationUrl: "https://auth.openai.com/device",
      },
      { _tag: "completed" },
      { _tag: "failed", message: "the login window was closed" },
    ];

    for (const variant of variants) {
      expect(roundTrip(variant)).toEqual(variant);
    }
  });

  it("fails closed on an unknown tag", () => {
    expect(decodeFails({ _tag: "apiKey", apiKey: "sk-secret" })).toBe(true);
  });

  it("fails closed when a required field is missing", () => {
    expect(decodeFails({ _tag: "browserHandoff" })).toBe(true);
  });

  it("rejects a blank device code", () => {
    expect(
      decodeFails({
        _tag: "deviceCode",
        userCode: "   ",
        verificationUrl: "https://auth.openai.com/device",
      }),
    ).toBe(true);
  });

  it("accepts an empty failure message", () => {
    expect(roundTrip({ _tag: "failed", message: "" })).toEqual({ _tag: "failed", message: "" });
  });
});

describe("ProviderSignInMode", () => {
  it("exposes exactly the two supported modes", () => {
    expect([...PROVIDER_SIGN_IN_MODES]).toEqual(["browser", "deviceCode"]);
    expect(isSignInMode("browser")).toBe(true);
    expect(isSignInMode("deviceCode")).toBe(true);
    expect(isSignInMode("apiKey")).toBe(false);
  });

  it("rejects a start input with an unknown mode", () => {
    expect(decodeInput({ instanceId: "codex", mode: "apiKey" })._tag).toBe("Failure");
    expect(decodeInput({ instanceId: "codex", mode: "deviceCode" })._tag).toBe("Success");
  });
});

describe("ProviderAuthError", () => {
  it("covers every member of the union", () => {
    const instanceId = ProviderInstanceId.make("codex");

    expect(
      isAuthError(new ProviderAuthUnsupportedError({ instanceId, reason: "unknown instance" })),
    ).toBe(true);
    expect(isAuthError(new ProviderAuthLoginInProgressError({ instanceId }))).toBe(true);
    expect(isAuthError(new ProviderAuthFailedError({ instanceId, detail: "boom" }))).toBe(true);
  });

  it("keeps the instance id and detail in the message", () => {
    const instanceId = ProviderInstanceId.make("codex-work");

    expect(new ProviderAuthLoginInProgressError({ instanceId }).message).toContain("codex-work");
    expect(new ProviderAuthFailedError({ instanceId, detail: "boom" }).message).toContain("boom");
  });
});
