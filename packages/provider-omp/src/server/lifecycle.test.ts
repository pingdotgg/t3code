import { expect, it } from "@effect/vitest";
import { isOmpSessionSettled, ompPromptFailure, ompForkMessageParent } from "./lifecycle.ts";

it("keeps yielded OMP turns open while background work remains", () => {
  expect(
    isOmpSessionSettled({
      isStreaming: false,
      isSettled: false,
      hasPendingAsyncWork: true,
      queuedMessageCount: 0,
    }),
  ).toBe(false);
  expect(
    isOmpSessionSettled({
      isStreaming: false,
      isSettled: true,
      hasPendingAsyncWork: false,
      queuedMessageCount: 0,
    }),
  ).toBe(true);
  expect(isOmpSessionSettled({ isStreaming: false })).toBe(false);
  expect(
    isOmpSessionSettled({
      isStreaming: false,
      isSettled: true,
      hasPendingAsyncWork: false,
      queuedMessageCount: 1,
    }),
  ).toBe(false);
});
it("reads native prompt-result failures without interpreting acceptance as completion", () => {
  expect(ompPromptFailure({ type: "response", command: "prompt", success: true })).toBeUndefined();
  expect(
    ompPromptFailure({
      type: "prompt_result",
      status: "error",
      error: { message: "Cost cap reached" },
    }),
  ).toBe("Cost cap reached");
  expect(
    ompPromptFailure({ type: "prompt_result", status: "completed", sessionSettled: false }),
  ).toBeUndefined();
});

it("forks at the preceding message because native OMP rejects metadata entries", () => {
  const entries = new Map([
    ["model", { parentId: null, isMessage: false }],
    ["first", { parentId: "model", isMessage: true }],
    ["answer", { parentId: "first", isMessage: true }],
    ["settings", { parentId: "answer", isMessage: false }],
    ["next", { parentId: "settings", isMessage: true }],
  ]);
  expect(ompForkMessageParent(entries, "first")).toBeNull();
  expect(ompForkMessageParent(entries, "next")).toBe("answer");
});
