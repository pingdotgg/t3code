import { describe, expect, it } from "vite-plus/test";

import { extractProviderErrorMessage } from "./providerError.ts";

describe("extractProviderErrorMessage", () => {
  it("returns plain messages unchanged", () => {
    expect(extractProviderErrorMessage("Something went wrong")).toBe("Something went wrong");
  });

  it("extracts the nested message from a codex/upstream error body", () => {
    const raw =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';
    expect(extractProviderErrorMessage(raw)).toBe(
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("extracts a top-level message field", () => {
    expect(extractProviderErrorMessage('{"message":"rate limited","code":429}')).toBe(
      "rate limited",
    );
  });

  it("unwraps double-encoded payloads", () => {
    const inner = '{"error":{"message":"quota exceeded"}}';
    const outer = JSON.stringify({ message: inner });
    expect(extractProviderErrorMessage(outer)).toBe("quota exceeded");
  });

  it("returns invalid JSON unchanged", () => {
    expect(extractProviderErrorMessage('{"type":"error", broken')).toBe('{"type":"error", broken');
  });

  it("returns JSON without a usable message unchanged", () => {
    expect(extractProviderErrorMessage('{"status":500}')).toBe('{"status":500}');
  });

  it("ignores empty or whitespace-only message fields", () => {
    expect(extractProviderErrorMessage('{"message":"  ","error":{"message":"real cause"}}')).toBe(
      "real cause",
    );
  });

  it("does not touch non-object JSON", () => {
    expect(extractProviderErrorMessage('"just a string"')).toBe('"just a string"');
    expect(extractProviderErrorMessage("[1,2,3]")).toBe("[1,2,3]");
  });
});
