import { describe, expect, it } from "vite-plus/test";

import { inferImageExtension, parseBase64DataUrl } from "./imageMime.ts";

describe("imageMime", () => {
  it("parses base64 data URL with mime parameters", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it.each(["\t", "\n", "\f", "\r", " "])(
    "parses base64 data URL with ASCII whitespace %j",
    (space) => {
      expect(parseBase64DataUrl(`data:image/png;base64,SGVs${space}bG8=\n`)).toEqual({
        mimeType: "image/png",
        base64: "SGVsbG8=",
      });
    },
  );

  it("rejects payload with characters outside the base64 alphabet", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs!bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVs,bG8=")).toBeNull();
    for (const space of ["\v", "\u00a0", "\u2003"]) {
      expect(parseBase64DataUrl(`data:image/png;base64,SGVs${space}bG8=`)).toBeNull();
    }
  });

  // regression: #3952 image upload crashed dispatchCommand with a stack overflow
  it("rejects structurally malformed base64", () => {
    expect(parseBase64DataUrl("data:image/png;base64,AB=CD===")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGV=bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=====AAA")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8")).toBeNull();
  });

  it("accepts base64 with one or two trailing padding characters", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbA==")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbA==",
    });
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8h")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8h",
    });
  });

  it("rejects empty and whitespace-only payloads", () => {
    expect(parseBase64DataUrl("data:image/png;base64,")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64, \t\r\n\f")).toBeNull();
  });

  it("parses a case-insensitive scheme and mime type", () => {
    expect(parseBase64DataUrl("DATA:IMAGE/PNG;BASE64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });
});
