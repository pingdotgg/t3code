import { describe, expect, it } from "vitest";
import { computeMessageDurationStart } from "./ChatView.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);
    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"], // user: own createdAt
        ["a1", "2026-01-01T00:00:00Z"], // assistant: user's createdAt
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);
    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"], // user: own createdAt
        ["a1", "2026-01-01T00:00:00Z"], // first assistant: from user (duration = 30s)
        ["a2", "2026-01-01T00:00:30Z"], // second assistant: from first assistant's completedAt (duration = 25s)
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" }, // streaming, no completedAt
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);
    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"], // user
        ["a1", "2026-01-01T00:00:00Z"], // streaming assistant: from user
        ["a2", "2026-01-01T00:00:00Z"], // next assistant: still from user (boundary not advanced)
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);
    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"], // first user
        ["a1", "2026-01-01T00:00:00Z"], // first assistant: from first user
        ["u2", "2026-01-01T00:01:00Z"], // second user: own createdAt
        ["a2", "2026-01-01T00:01:00Z"], // second assistant: from second user (not first assistant)
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);
    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"], // user
        ["s1", "2026-01-01T00:00:00Z"], // system: inherits user boundary
        ["a1", "2026-01-01T00:00:00Z"], // assistant: from user
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});
