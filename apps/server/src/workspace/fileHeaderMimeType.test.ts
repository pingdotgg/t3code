import { describe, expect, it } from "vite-plus/test";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

describe("fileHeaderMimeType", () => {
  it.each([
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    [[0xff, 0xd8, 0xff], "image/jpeg"],
    [[0x50, 0x4b, 0x03, 0x04], "application/zip"],
    [[0x52, 0x49, 0x46, 0x46, 0xc2, 0xa0, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    [[0x89, 0x50, 0x4e], undefined],
  ])("classifies binary header %j", (header, expected) => {
    expect(fileHeaderMimeType(new Uint8Array(header))).toBe(expected);
  });

  it.each([
    ["%PDF-1.7", "application/pdf"],
    ["GIF89a", "image/gif"],
    ["SQLite format 3\0", "application/vnd.sqlite3"],
    ["RIFF1234WEBP", "image/webp"],
    ["#!/usr/bin/env python3\n", "text/x-python"],
    ["#!/usr/bin/node\n", "text/javascript"],
    ["#!/bin/bash\n", "text/x-shellscript"],
    ["#!/usr/bin/env ruby\n", "text/x-ruby"],
    ["hello", undefined],
    ["", undefined],
    ["#!/usr/bin/env custom\n", undefined],
  ])("classifies %j", (header, expected) => {
    expect(fileHeaderMimeType(new TextEncoder().encode(header))).toBe(expected);
  });
});
