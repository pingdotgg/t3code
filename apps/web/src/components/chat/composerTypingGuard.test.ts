import { describe, expect, it } from "vite-plus/test";
import { createComposerTypingGuardState, updateComposerTypingGuard } from "./composerTypingGuard";

function typing() {
  return updateComposerTypingGuard(
    updateComposerTypingGuard(createComposerTypingGuardState(), { type: "focus" }),
    { type: "type", now: 1000 },
  );
}

describe("composer typing guard", () => {
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
      const released = state.held;
      state = updateComposerTypingGuard(state, { type });
      expect(state.held).toBe(released);
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

  it("does not hide a request that already took over when typing starts", () => {
    let state = updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds: ["question"],
      now: 0,
    });
    const held = state.held;
    state = updateComposerTypingGuard(state, { type: "focus" });
    state = updateComposerTypingGuard(state, { type: "type", now: 1000 });
    expect(state.held).toBe(held);
    state = updateComposerTypingGuard(state, {
      type: "requests",
      requestIds: ["question"],
      now: 1100,
    });
    expect([...state.held]).toEqual([]);
    expect(state.held).toBe(held);
  });
});
