import { describe, expect, it } from "vitest";
import { viteSupportsPortZero } from "../DevPort.ts";

describe("viteSupportsPortZero", () => {
  it("accepts 8.2.1 and later", () => {
    expect(viteSupportsPortZero("8.2.1")).toBe(true);
    expect(viteSupportsPortZero("8.2.2")).toBe(true);
    expect(viteSupportsPortZero("8.3.0")).toBe(true);
    expect(viteSupportsPortZero("9.0.0")).toBe(true);
    expect(viteSupportsPortZero("9.0.0-beta.1")).toBe(true);
  });

  it("rejects versions before 8.2.1", () => {
    expect(viteSupportsPortZero("8.2.0")).toBe(false);
    expect(viteSupportsPortZero("8.1.9")).toBe(false);
    expect(viteSupportsPortZero("7.2.6")).toBe(false);
    expect(viteSupportsPortZero("6.0.0")).toBe(false);
  });

  it("rejects missing or malformed versions", () => {
    expect(viteSupportsPortZero(undefined)).toBe(false);
    expect(viteSupportsPortZero(null)).toBe(false);
    expect(viteSupportsPortZero("")).toBe(false);
    expect(viteSupportsPortZero("next")).toBe(false);
  });
});
