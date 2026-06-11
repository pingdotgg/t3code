import { describe, expect, it } from "vite-plus/test";

import { isPickedElementPayload } from "./picked-element-payload.ts";

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    tagName: "button",
    selector: "button.submit",
    htmlPreview: "<button>Save</button>",
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/src/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    stack: [
      {
        functionName: "SubmitButton",
        fileName: "/repo/src/Button.tsx",
        lineNumber: 12,
        columnNumber: 5,
      },
    ],
    styles: ".submit { color: white; }",
    pickedAt: "2026-05-03T18:00:00.000Z",
    ...overrides,
  };
}

describe("isPickedElementPayload", () => {
  it("accepts a complete, well-typed payload", () => {
    expect(isPickedElementPayload(validPayload())).toBe(true);
  });

  it("accepts nullable string fields when null", () => {
    expect(
      isPickedElementPayload(
        validPayload({ pageTitle: null, selector: null, componentName: null, source: null }),
      ),
    ).toBe(true);
  });

  it("accepts an empty stack array", () => {
    expect(isPickedElementPayload(validPayload({ stack: [] }))).toBe(true);
  });

  it("accepts stack frames with null fields", () => {
    expect(
      isPickedElementPayload(
        validPayload({
          stack: [
            {
              functionName: null,
              fileName: null,
              lineNumber: null,
              columnNumber: null,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects null and primitive inputs", () => {
    expect(isPickedElementPayload(null)).toBe(false);
    expect(isPickedElementPayload(undefined)).toBe(false);
    expect(isPickedElementPayload("string")).toBe(false);
    expect(isPickedElementPayload(42)).toBe(false);
    expect(isPickedElementPayload([])).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["missing pageUrl", validPayload({ pageUrl: undefined })],
    ["wrong-type pageUrl", validPayload({ pageUrl: 123 })],
    ["missing tagName", validPayload({ tagName: undefined })],
    ["missing htmlPreview", validPayload({ htmlPreview: undefined })],
    ["missing styles", validPayload({ styles: undefined })],
    ["missing pickedAt", validPayload({ pickedAt: undefined })],
    ["wrong-type pageTitle", validPayload({ pageTitle: 99 })],
    ["wrong-type selector", validPayload({ selector: 99 })],
    ["wrong-type componentName", validPayload({ componentName: 99 })],
  ])("rejects payloads with %s", (_label, value) => {
    expect(isPickedElementPayload(value)).toBe(false);
  });

  it("rejects malformed source frames", () => {
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: 0,
            fileName: null,
            lineNumber: null,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects non-finite numeric line/column numbers", () => {
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.POSITIVE_INFINITY,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.NaN,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects malformed stack arrays", () => {
    expect(isPickedElementPayload(validPayload({ stack: "not-an-array" }))).toBe(false);
    expect(isPickedElementPayload(validPayload({ stack: [{ bogus: true }] }))).toBe(false);
  });
});
