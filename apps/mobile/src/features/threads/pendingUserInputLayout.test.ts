import { describe, expect, it } from "vite-plus/test";
import { derivePendingUserInputMaxHeight } from "./pendingUserInputLayout";

describe("pending input height", () => {
  it.each([
    {
      windowHeight: 678,
      keyboardHeight: 0,
      navigationHeaderHeight: 82,
      composerOverlapHeight: 84,
      expected: 500,
    },
    {
      windowHeight: 678,
      keyboardHeight: 318,
      navigationHeaderHeight: 82,
      composerOverlapHeight: 100,
      expected: 166,
    },
    {
      windowHeight: 300,
      keyboardHeight: 200,
      navigationHeaderHeight: 44,
      composerOverlapHeight: 32,
      expected: 12,
    },
    {
      windowHeight: 300,
      keyboardHeight: 260,
      navigationHeaderHeight: 44,
      composerOverlapHeight: 32,
      expected: 0,
    },
    {
      windowHeight: 951,
      keyboardHeight: 0,
      navigationHeaderHeight: 82,
      composerOverlapHeight: 18,
      expected: 560,
    },
  ])("fits between the header and bottom controls: %j", ({ expected, ...input }) => {
    expect(derivePendingUserInputMaxHeight(input)).toBe(expected);
  });
});
