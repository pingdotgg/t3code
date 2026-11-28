import { describe, expect, it } from "vite-plus/test";

import { parseActiveThreadPath } from "./hardwareKeyboardCommands";

describe("parseActiveThreadPath", () => {
  it("decodes route components", () => {
    expect(parseActiveThreadPath("/threads/local%20machine/thread%2Fone/review")).toEqual({
      environmentId: "local machine",
      threadId: "thread/one",
    });
  });

  it("stops the thread id at the route's query or fragment", () => {
    expect(
      parseActiveThreadPath("/threads/team/thread-17?inspector=%5Bobject%20Object%5D"),
    ).toEqual({ environmentId: "team", threadId: "thread-17" });
    expect(parseActiveThreadPath("/threads/team/thread-17#anchor")).toEqual({
      environmentId: "team",
      threadId: "thread-17",
    });
  });

  it("ignores malformed encoded route components", () => {
    expect(parseActiveThreadPath("/threads/%E0%A4%A/thread-1")).toBeNull();
  });
});
