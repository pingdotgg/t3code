import { describe, expect, it } from "vite-plus/test";

import {
  canExplainThreadError,
  deriveThreadErrorExplanationView,
} from "./ThreadErrorExplanation.logic";

const settled = { isPending: false, data: null, error: null } as const;

describe("canExplainThreadError", () => {
  it("offers the action for server provider failures", () => {
    expect(canExplainThreadError({ errorClass: "provider_error", hasTarget: true })).toBe(true);
    expect(canExplainThreadError({ errorClass: "unknown", hasTarget: true })).toBe(true);
    expect(canExplainThreadError({ errorClass: null, hasTarget: true })).toBe(true);
  });

  it("hides the action for usage limits", () => {
    expect(canExplainThreadError({ errorClass: "usage_limit", hasTarget: true })).toBe(false);
  });

  it("hides the action without a server thread to ask about", () => {
    expect(canExplainThreadError({ errorClass: "provider_error", hasTarget: false })).toBe(false);
  });
});

describe("deriveThreadErrorExplanationView", () => {
  it("asks nothing until the user requests an explanation", () => {
    expect(deriveThreadErrorExplanationView({ requested: false, ...settled })).toEqual({
      kind: "idle",
    });
  });

  it("reports pending while the request is in flight, even after an earlier failure", () => {
    expect(
      deriveThreadErrorExplanationView({
        requested: true,
        isPending: true,
        data: null,
        error: "Couldn't reach the model",
      }),
    ).toEqual({ kind: "pending" });
  });

  it("shows the explanation once it arrives", () => {
    expect(
      deriveThreadErrorExplanationView({
        requested: true,
        isPending: false,
        data: { failureMessage: "boom", summary: "The session died.", likelyFix: "Restart it." },
        error: null,
      }),
    ).toEqual({ kind: "ready", summary: "The session died.", likelyFix: "Restart it." });
  });

  it("surfaces the failure so the user can retry", () => {
    expect(
      deriveThreadErrorExplanationView({ requested: true, ...settled, error: "No model" }),
    ).toEqual({ kind: "failed", message: "No model" });
  });
});
