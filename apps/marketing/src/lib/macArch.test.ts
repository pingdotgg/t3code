import { describe, expect, it } from "vite-plus/test";

import { macArchFromGpuRenderer } from "./macArch";

describe("macArchFromGpuRenderer", () => {
  it("detects explicit Apple Silicon renderers", () => {
    expect(macArchFromGpuRenderer("Apple M4 Pro")).toBe("arm64");
  });

  it("prefers an Intel GPU marker even when the renderer also mentions Apple", () => {
    expect(macArchFromGpuRenderer("ANGLE Metal Renderer: Apple, Intel Iris Plus Graphics")).toBe(
      "x64",
    );
  });

  it("detects Safari's generic Apple Silicon renderer", () => {
    expect(macArchFromGpuRenderer("Apple GPU")).toBe("arm64");
  });

  it("uses x64 when the renderer is unavailable", () => {
    expect(macArchFromGpuRenderer("")).toBe("x64");
  });
});
