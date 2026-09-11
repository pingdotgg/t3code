import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  DEVIN_RESOURCE_TEXT_MAX_CHARS,
  normalizeDevinResourceContent,
} from "./DevinResourceSupport.ts";

describe("Devin ACP resource normalization", () => {
  // Task 2 did not observe resource content from the installed Devin CLI. These are
  // intentionally synthetic, typed ACP schema fixtures; they are not live Devin evidence.
  it("normalizes a typed ACP resource-link fixture", () => {
    const fixture = {
      type: "content",
      content: {
        type: "resource_link",
        uri: "urn:acp:fixture:resource-link",
        name: "schema fixture",
        description: "typed protocol fixture",
        mimeType: "text/markdown",
      },
    } satisfies EffectAcpSchema.ToolCallContent;

    expect(normalizeDevinResourceContent(fixture)).toEqual({
      kind: "resource",
      resource: {
        uri: "urn:acp:fixture:resource-link",
        name: "schema fixture",
        description: "typed protocol fixture",
        mimeType: "text/markdown",
      },
    });
  });

  it("normalizes a typed ACP embedded-text resource fixture", () => {
    const fixture = {
      type: "content",
      content: {
        type: "resource",
        resource: {
          uri: "urn:acp:fixture:embedded-text",
          mimeType: "text/plain",
          text: "protocol fixture",
        },
      },
    } satisfies EffectAcpSchema.ToolCallContent;

    expect(normalizeDevinResourceContent(fixture)).toEqual({
      kind: "resource",
      resource: {
        uri: "urn:acp:fixture:embedded-text",
        mimeType: "text/plain",
        text: "protocol fixture",
      },
    });
  });

  it("omits null optional resource-link metadata", () => {
    const fixture = {
      type: "content",
      content: {
        type: "resource_link",
        uri: "https://resources.example/acp/null-metadata",
        name: "ACP reference",
        description: null,
        mimeType: null,
      },
    } satisfies EffectAcpSchema.ToolCallContent;

    expect(normalizeDevinResourceContent(fixture)).toEqual({
      kind: "resource",
      resource: {
        uri: "https://resources.example/acp/null-metadata",
        name: "ACP reference",
      },
    });
  });

  it("rejects malformed optional resource content without throwing", () => {
    expect(
      normalizeDevinResourceContent({
        type: "content",
        content: { type: "resource", resource: { uri: 42, text: "fixture" } },
      }),
    ).toEqual({ kind: "unsupported", reason: "invalid" });
  });

  it("rejects resource content missing its required URI", () => {
    expect(
      normalizeDevinResourceContent({
        type: "content",
        content: { type: "resource_link", name: "fixture" },
      }),
    ).toEqual({ kind: "unsupported", reason: "invalid" });
  });

  it("rejects oversized embedded text", () => {
    const fixture = {
      type: "content",
      content: {
        type: "resource",
        resource: {
          uri: "https://resources.example/acp/oversized",
          text: "x".repeat(DEVIN_RESOURCE_TEXT_MAX_CHARS + 1),
        },
      },
    } satisfies EffectAcpSchema.ToolCallContent;

    expect(normalizeDevinResourceContent(fixture)).toEqual({
      kind: "unsupported",
      reason: "oversized",
    });
  });

  it("rejects a protocol-schema embedded blob without decoding it", () => {
    const fixture = {
      type: "content",
      content: {
        type: "resource",
        resource: {
          uri: "https://resources.example/acp/binary",
          mimeType: "application/octet-stream",
          blob: "opaque-binary-fixture",
        },
      },
    } satisfies EffectAcpSchema.ToolCallContent;

    expect(normalizeDevinResourceContent(fixture)).toEqual({
      kind: "unsupported",
      reason: "binary",
    });
  });

  it("rejects a malformed blob field rather than treating it as text", () => {
    expect(
      normalizeDevinResourceContent({
        type: "content",
        content: {
          type: "resource",
          resource: {
            uri: "urn:acp:fixture:malformed-blob",
            text: "typed protocol fixture",
            blob: 42,
          },
        },
      }),
    ).toEqual({ kind: "unsupported", reason: "invalid" });
  });
});
