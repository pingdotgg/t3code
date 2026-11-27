import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
} from "./desktopAppActivation.ts";

const isRequest = Schema.is(DesktopAppActivationRequest);
const isResponse = Schema.is(DesktopAppActivationResponse);

describe("desktop app activation requests", () => {
  it("accepts a pairing request, but only with a pairing URL", () => {
    const pair = {
      version: 1,
      requestId: "request-1",
      type: "pair-environment",
      pairingUrl: "https://vps.example.com/pair#token=abc",
    };

    expect(isRequest(pair)).toBe(true);
    expect(isRequest({ ...pair, pairingUrl: "  " })).toBe(false);
    expect(isRequest({ ...pair, type: "open-workspace" })).toBe(false);
  });

  it("answers a pairing request with the saved environment, or a reason it was not saved", () => {
    const base = { version: 1, requestId: "request-1" };

    expect(isResponse({ ...base, ok: true, environmentId: "environment-1" })).toBe(true);
    expect(
      isResponse({
        ...base,
        ok: false,
        code: "environment-already-saved",
        message: "That backend is already saved in T3 Code.",
      }),
    ).toBe(true);
  });
});
