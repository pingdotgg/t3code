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

  it("uses x64 for ambiguous Safari and unavailable renderer values", () => {
    expect(macArchFromGpuRenderer("Apple GPU")).toBe("x64");
    expect(macArchFromGpuRenderer("")).toBe("x64");
  });
});
