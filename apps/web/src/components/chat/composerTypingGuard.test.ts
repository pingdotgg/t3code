import { describe, expect, it } from "vite-plus/test";
import { createComposerTypingGuardState, updateComposerTypingGuard } from "./composerTypingGuard";

function typing() {
  return updateComposerTypingGuard(
    updateComposerTypingGuard(createComposerTypingGuardState(), { type: "focus" }),
    { type: "type", now: 1000 },
  );
}

describe("composer typing guard", () => {
  it("holds new requests while the focused draft was recently edited", () => {
    const state = updateComposerTypingGuard(typing(), {
      type: "requests",
      requestIds: ["approval", "question"],
      now: 2499,
    });
    expect([...state.held]).toEqual(["approval", "question"]);
  });

  it.each(["idle", "send", "blur"] as const)(
    "releases on %s and never re-holds the request",
    (type) => {
      let state = updateComposerTypingGuard(typing(), {
        type: "requests",
        requestIds: ["question"],
        now: 1200,
      });
      state = updateComposerTypingGuard(state, { type });
      expect([...state.held]).toEqual([]);
      state = updateComposerTypingGuard(state, { type: "focus" });
      state = updateComposerTypingGuard(state, { type: "type", now: 2000 });
      state = updateComposerTypingGuard(state, { type: "requests", requestIds: [], now: 2100 });
      state = updateComposerTypingGuard(state, {
        type: "requests",
        requestIds: ["question", "new-question"],
        now: 2200,
      });
      expect([...state.held]).toEqual(["new-question"]);
    },
  );

  it("shows requests immediately when idle or unfocused", () => {
    for (const state of [
      createComposerTypingGuardState(),
      typing(),
      updateComposerTypingGuard(typing(), { type: "blur" }),
    ]) {
      expect([
        ...updateComposerTypingGuard(state, {
          type: "requests",
          requestIds: ["question"],
          now: 2500,
        }).held,
      ]).toEqual([]);
    }
  });

  it("does not hide a request that already took over when typing starts", () => {
    let state = updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds: ["question"],
      now: 0,
    });
    state = updateComposerTypingGuard(state, { type: "focus" });
    state = updateComposerTypingGuard(state, { type: "type", now: 1000 });
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["question"],
      now: 1100,
    });
    expect([...state.held]).toEqual([]);
  });

  it("drops a hold when its request is resolved", () => {
    const held = updateComposerTypingGuard(typing(), {
      type: "requests",
      requestIds: ["question"],
      now: 1100,
    });
    expect([
      ...updateComposerTypingGuard(held, {
        type: "requests",
        requestIds: [],
        now: 1200,
      }).held,
    ]).toEqual([]);
  });
});
