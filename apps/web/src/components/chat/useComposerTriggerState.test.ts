import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger } from "../../composer-logic";
import {
  type ComposerTriggerChange,
  type ComposerTriggerState,
  nextComposerTriggerState,
  openComposerTrigger,
} from "./useComposerTriggerState";

const closed: ComposerTriggerState = { open: null, dismissed: null };

function step(
  state: ComposerTriggerState,
  change: ComposerTriggerChange,
  text: string,
  cursor = text.length,
) {
  return nextComposerTriggerState(state, detectComposerTrigger(text, cursor), change);
}

describe("composer suggestions", () => {
  const draft = "# Heading\nsee #12 and $skill\n/plan @src";

  it.each([
    ["a heading's #", 1, "pull-request"],
    ["#12", draft.indexOf("#12") + 3, "pull-request"],
    ["$skill", draft.indexOf("$skill") + 6, "skill"],
    ["/plan", draft.indexOf("/plan") + 5, "slash-command"],
    ["@src", draft.length, "path"],
  ])("stay closed when the caret moves onto %s", (_label, cursor, kind) => {
    const candidate = detectComposerTrigger(draft, cursor);
    expect(candidate?.kind).toBe(kind);

    const state = nextComposerTriggerState(closed, candidate, "caret");

    expect(state.open).toBeNull();
    expect(openComposerTrigger(state, candidate)).toBeNull();
  });

  it("open on an edit, follow the caret inside the trigger, and stay closed once it leaves", () => {
    const typed = "see #123";
    let state = step(closed, "edit", typed);
    expect(state.open).toMatchObject({ kind: "pull-request", query: "123" });
    expect(openComposerTrigger(state, detectComposerTrigger(typed, typed.length))?.query).toBe(
      "123",
    );

    state = step(state, "caret", typed, typed.length - 1);
    expect(state.open?.query).toBe("12");

    state = step(state, "caret", typed, 0);
    state = step(state, "caret", typed);
    expect(state.open).toBeNull();

    state = step(state, "edit", `${typed}4`);
    expect(state.open?.query).toBe("1234");
  });

  it("stay dismissed while the dismissed word is edited, and open for the next word", () => {
    const dismissed = detectComposerTrigger("pnpm i @openai", "pnpm i @openai".length);
    let state = step({ open: null, dismissed }, "edit", "pnpm i @openai/codex");
    expect(state.open).toBeNull();

    state = step(state, "edit", "pnpm i @openai/codex ");
    state = step(state, "edit", "pnpm i @openai/codex @src");
    expect(state.open?.query).toBe("src");
  });
});
