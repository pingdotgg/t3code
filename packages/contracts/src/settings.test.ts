import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ChatFontSize,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  ClientSettingsSchema,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
} from "./settings.ts";

const decodeChatFontSize = Schema.decodeUnknownSync(ChatFontSize);
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

describe("ChatFontSize schema", () => {
  it("exposes the expected bounds and default", () => {
    expect(CHAT_FONT_SIZE_MIN).toBe(12);
    expect(CHAT_FONT_SIZE_MAX).toBe(24);
    expect(DEFAULT_CHAT_FONT_SIZE).toBe(14);
  });

  it("accepts the default, min and max values", () => {
    expect(decodeChatFontSize(DEFAULT_CHAT_FONT_SIZE)).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(decodeChatFontSize(CHAT_FONT_SIZE_MIN)).toBe(CHAT_FONT_SIZE_MIN);
    expect(decodeChatFontSize(CHAT_FONT_SIZE_MAX)).toBe(CHAT_FONT_SIZE_MAX);
  });

  it("rejects values below the minimum", () => {
    expect(() => decodeChatFontSize(CHAT_FONT_SIZE_MIN - 1)).toThrow();
  });

  it("rejects values above the maximum", () => {
    expect(() => decodeChatFontSize(CHAT_FONT_SIZE_MAX + 1)).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() => decodeChatFontSize(14.5)).toThrow();
  });

  it("rejects non-numeric values", () => {
    expect(() => decodeChatFontSize("14")).toThrow();
    expect(() => decodeChatFontSize(null)).toThrow();
  });
});

describe("ClientSettingsSchema chatFontSize decoding default", () => {
  it("fills in the default when chatFontSize is omitted from the input", () => {
    const parsed = decodeClientSettings({});
    expect(parsed.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
  });

  it("preserves a provided chatFontSize inside the valid range", () => {
    const parsed = decodeClientSettings({ chatFontSize: 20 });
    expect(parsed.chatFontSize).toBe(20);
  });

  it("rejects a chatFontSize outside the valid range", () => {
    expect(() => decodeClientSettings({ chatFontSize: 100 })).toThrow();
  });
});

describe("Default settings objects expose chatFontSize", () => {
  it("DEFAULT_CLIENT_SETTINGS carries the default chat font size", () => {
    expect(DEFAULT_CLIENT_SETTINGS.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
  });

  it("DEFAULT_UNIFIED_SETTINGS carries the default chat font size", () => {
    expect(DEFAULT_UNIFIED_SETTINGS.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
  });
});
