import { describe, expect, it } from "vite-plus/test";

import { pickedElementSource } from "./PickedElementSource.ts";

describe("pickedElementSource", () => {
  it("reports the resolved file, line, and column", () => {
    expect(
      pickedElementSource({
        componentName: "Home",
        filePath: "/repo/src/app/page.tsx",
        lineNumber: 12,
        columnNumber: 19,
      }),
    ).toEqual({
      functionName: "Home",
      fileName: "/repo/src/app/page.tsx",
      lineNumber: 12,
      columnNumber: 19,
    });
  });

  // react-grab resolves the source location separately from the call stack, so
  // this must survive a component that reports no stack at all — the case that
  // used to leave every pick without a file.
  it("reports a file even when only the path resolved", () => {
    expect(
      pickedElementSource({
        componentName: null,
        filePath: "/repo/src/app/page.tsx",
        lineNumber: null,
        columnNumber: null,
      }),
    ).toEqual({
      functionName: null,
      fileName: "/repo/src/app/page.tsx",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("yields nothing without a path, so the caller can fall back to the stack", () => {
    expect(
      pickedElementSource({
        componentName: "Home",
        filePath: null,
        lineNumber: 12,
        columnNumber: 19,
      }),
    ).toBe(null);
  });
});
