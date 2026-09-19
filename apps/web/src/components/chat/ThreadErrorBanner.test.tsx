import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("shows the message from the reported unsupported-model error", () => {
    const error =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';

    expect(getThreadErrorBannerMessage(error)).toBe(
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("shows the message from the reported multiline error", () => {
    const error = `{
  "error": {
    "message": "X-OpenAI-Internal-Codex-Responses-Lite only supports function tools, custom tools, and client-executed tool search.",
    "type": "invalid_request_error",
    "param": "tools",
    "code": "unsupported_value"
  }
}`;

    expect(getThreadErrorBannerMessage(error)).toBe(
      "X-OpenAI-Internal-Codex-Responses-Lite only supports function tools, custom tools, and client-executed tool search.",
    );
  });

  it("preserves whitespace in a recognized message", () => {
    const message = "  First line\n\tSecond line  ";
    const error = ` \n${JSON.stringify({ error: { message } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it("does not recursively unwrap a selected message", () => {
    const message = JSON.stringify({ error: { message: "Inner message" } });

    expect(getThreadErrorBannerMessage(JSON.stringify({ error: { message } }))).toBe(message);
  });

  it.each([
    ["plain text and its whitespace", "  Could not start the turn.\nTry again.  "],
    ["empty text", ""],
    ["whitespace-only text", " \n\t "],
    ["invalid JSON", '{"error":{"message":"Cut off"'],
    ["JSON null", "null"],
    ["a JSON string", '"Could not start the turn."'],
    ["a JSON number", "400"],
    ["an array", '[{"error":{"message":"Array entry"}}]'],
    ["a top-level message", '{"message":"Top-level message"}'],
    ["an unknown object", '{"status":400,"code":"unsupported_value"}'],
    ["a null error", '{"error":null}'],
    ["a string-valued error", '{"error":"Could not start the turn."}'],
    ["an array-valued error", '{"error":[{"message":"Array entry"}]}'],
    ["an absent message", '{"error":{"code":"unsupported_value"}}'],
    ["an empty message", '{"error":{"message":""}}'],
    ["a whitespace-only message", JSON.stringify({ error: { message: " \n\t " } })],
    ["a non-string message", '{"error":{"message":400}}'],
    ["a deeper error object", '{"error":{"error":{"message":"Deeper message"}}}'],
    ["double-encoded JSON", JSON.stringify('{"error":{"message":"Encoded message"}}')],
  ])("leaves %s unchanged", (_description, error) => {
    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
});

describe("ThreadErrorBanner", () => {
  it("does not dismiss different diagnostics that share the same headline", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const threadKey = "env:thread-same-headline";
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey(threadKey, firstError));

    expect(getThreadErrorBannerMessage(firstError)).toBe("Turn failed");
    expect(getThreadErrorBannerMessage(secondError)).toBe("Turn failed");
    expect(
      shouldShowThreadErrorBanner(
        threadKey,
        secondError,
        isThreadErrorBannerDismissedForSession(getThreadErrorBannerKey(threadKey, secondError)),
      ),
    ).toBe(true);
  });

  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
  });
  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });
});
