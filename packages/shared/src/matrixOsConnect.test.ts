import { describe, expect, it } from "vite-plus/test";

import {
  MATRIX_OS_CONNECT_URL,
  MATRIX_OS_SETUP_ACTION_LABEL,
  MATRIX_OS_SETUP_DESCRIPTION,
  MATRIX_OS_SETUP_MOBILE_ACTION_LABEL,
} from "./matrixOsConnect.js";

describe("MATRIX_OS_CONNECT_URL", () => {
  it("targets the canonical Matrix OS Terminal with the fixed T3 action", () => {
    const url = new URL(MATRIX_OS_CONNECT_URL);

    expect(url.origin).toBe("https://app.matrix-os.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("launch")).toBe("__terminal__");
    expect(url.searchParams.get("terminal_action")).toBe("t3-connect");
    expect(new Set(url.searchParams.keys())).toEqual(new Set(["launch", "terminal_action"]));
  });
});

describe("Matrix OS setup copy", () => {
  it("describes an onboarding action instead of claiming connection status", () => {
    expect(MATRIX_OS_SETUP_ACTION_LABEL).toBe("Set up");
    expect(MATRIX_OS_SETUP_MOBILE_ACTION_LABEL).toBe("Open Matrix OS setup");
    expect(MATRIX_OS_SETUP_DESCRIPTION).toContain("one-time pairing link");
    expect(MATRIX_OS_SETUP_DESCRIPTION).toContain("No T3 account required");
  });
});
