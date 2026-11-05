import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  threadFailureIsShownElsewhere,
} from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("extracts a readable nested message without trimming its whitespace", () => {
    const message =
      "  This model is not supported with a ChatGPT account.\nChoose another model.  ";
    const error = ` \n${JSON.stringify({ error: { message, code: "unsupported_model" } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it("keeps the diagnostics when the nested message is blank", () => {
    const error = JSON.stringify({ error: { message: " \n\t ", code: "unsupported_model" } });

    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
});

describe("ThreadErrorBanner", () => {
  it("reappears for different diagnostics with the same headline on the same thread", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const dismissedKey = getThreadErrorBannerKey("env:thread-b", firstError);
    dismissThreadErrorBannerForSession(dismissedKey);
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", secondError);

    expect(isThreadErrorBannerDismissedForSession(dismissedKey)).toBe(true);
    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        secondError,
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });
});

describe("threadFailureIsShownElsewhere", () => {
  it("hides the banner for classified failures, which have their own row", () => {
    expect(threadFailureIsShownElsewhere("provider_error", "boom")).toBe(true);
    expect(threadFailureIsShownElsewhere("usage_limit", "usage_limit")).toBe(true);
  });

  it("keeps the banner for unclassified failures", () => {
    expect(threadFailureIsShownElsewhere(null, null)).toBe(false);
  });

  it("keeps a ChatGPT limit outside usage_limit and hides one inside it", () => {
    const code = "subscription_sharing_usage_limit_exceeded";
    expect(threadFailureIsShownElsewhere("provider_error", code)).toBe(false);
    expect(threadFailureIsShownElsewhere("usage_limit", code)).toBe(true);
  });
});
