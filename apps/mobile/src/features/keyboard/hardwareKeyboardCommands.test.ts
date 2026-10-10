import { describe, expect, it } from "vite-plus/test";

import { nextEnvironmentId, parseActiveThreadPath } from "./hardwareKeyboardCommands";

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

describe("nextEnvironmentId", () => {
  const environments = [{ environmentId: "a" }, { environmentId: "b" }, { environmentId: "c" }];

  it.each([
    ["the next machine", "a", "b"],
    ["the first machine after the last", "c", "a"],
    ["the first machine when the current one is not listed", "gone", "a"],
    ["the first machine when there is no current one", null, "a"],
  ])("returns %s", (_label, current, expected) => {
    expect(nextEnvironmentId(environments, current)).toBe(expected);
  });

  it("returns null when there is nowhere else to go", () => {
    expect(nextEnvironmentId([{ environmentId: "a" }], "a")).toBeNull();
  });
});
