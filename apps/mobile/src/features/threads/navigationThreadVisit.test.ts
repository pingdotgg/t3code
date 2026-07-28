import { describe, expect, it } from "vite-plus/test";

import { recordThreadVisit, threadVisitKeyFromNavigationState } from "./navigationThreadVisit";

describe("recordThreadVisit", () => {
  it("updates a visit and prunes the oldest markers at the requested limit", () => {
    expect(
      recordThreadVisit(
        {
          oldest: "2026-06-01T08:00:00.000Z",
          middle: "2026-06-01T09:00:00.000Z",
        },
        "newest",
        "2026-06-01T10:00:00.000Z",
        2,
      ),
    ).toEqual({
      middle: "2026-06-01T09:00:00.000Z",
      newest: "2026-06-01T10:00:00.000Z",
    });
  });
});

describe("threadVisitKeyFromNavigationState", () => {
  it("tracks direct and auxiliary thread destinations", () => {
    expect(
      threadVisitKeyFromNavigationState({
        index: 1,
        routes: [
          { name: "Home" },
          {
            name: "Thread",
            params: { environmentId: "environment-1", threadId: "thread-1" },
          },
        ],
      }),
    ).toBe("environment-1:thread-1");

    expect(
      threadVisitKeyFromNavigationState({
        routes: [
          {
            name: "ThreadReview",
            params: { environmentId: ["environment-2"], threadId: ["thread-2"] },
          },
        ],
      }),
    ).toBe("environment-2:thread-2");
  });

  it("uses the deepest active route in restored nested state", () => {
    expect(
      threadVisitKeyFromNavigationState({
        routes: [
          {
            name: "Root",
            state: {
              index: 1,
              routes: [
                { name: "Home" },
                {
                  name: "ThreadFiles",
                  params: { environmentId: "environment-3", threadId: "thread-3" },
                },
              ],
            },
          },
        ],
      }),
    ).toBe("environment-3:thread-3");
  });

  it("tracks git destinations that do not use the Thread route prefix", () => {
    for (const routeName of ["GitOverview", "GitCommit", "GitBranches", "GitConfirm"]) {
      expect(
        threadVisitKeyFromNavigationState({
          routes: [
            {
              name: routeName,
              params: { environmentId: "environment-git", threadId: "thread-git" },
            },
          ],
        }),
      ).toBe("environment-git:thread-git");
    }
  });

  it("ignores non-thread destinations", () => {
    expect(
      threadVisitKeyFromNavigationState({
        routes: [
          {
            name: "SettingsSheet",
            state: {
              routes: [{ name: "Settings", params: { environmentId: "env", threadId: "thread" } }],
            },
          },
        ],
      }),
    ).toBeNull();
    expect(threadVisitKeyFromNavigationState({ routes: [{ name: "Home" }] })).toBeNull();
  });

  it("ignores malformed thread params", () => {
    expect(
      threadVisitKeyFromNavigationState({
        routes: [{ name: "Thread", params: { environmentId: "environment-1" } }],
      }),
    ).toBeNull();
  });
});
