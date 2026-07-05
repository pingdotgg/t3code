import { describe, expect, it } from "vite-plus/test";

import { parseActiveThreadPath } from "./hardwareKeyboardCommands";

describe("parseActiveThreadPath", () => {
  it("extracts the active thread from thread subroutes", () => {
    expect(parseActiveThreadPath("/threads/environment-1/thread-1/files/src/index.ts")).toEqual({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
  });

  it("decodes route components", () => {
    expect(parseActiveThreadPath("/threads/local%20machine/thread%2Fone/review")).toEqual({
      environmentId: "local machine",
      threadId: "thread/one",
    });
  });

  it("ignores non-thread routes", () => {
    expect(parseActiveThreadPath("/settings")).toBeNull();
    expect(parseActiveThreadPath("/threads/environment-only")).toBeNull();
  });

  it("ignores malformed encoded route components", () => {
    expect(parseActiveThreadPath("/threads/%E0%A4%A/thread-1")).toBeNull();
  });
});
