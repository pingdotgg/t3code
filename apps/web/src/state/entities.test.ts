import { describe, expect, it } from "vite-plus/test";

import { shouldSubscribeToThreadDetail } from "./entities";

describe("thread detail subscription", () => {
  it("waits for a server shell before subscribing for a local draft", () => {
    expect(
      shouldSubscribeToThreadDetail({
        hasLocalDraft: true,
        hasServerShell: false,
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToThreadDetail({
        hasLocalDraft: true,
        hasServerShell: true,
      }),
    ).toBe(true);
  });

  it("keeps normal server thread subscriptions independent of shell state", () => {
    expect(
      shouldSubscribeToThreadDetail({
        hasLocalDraft: false,
        hasServerShell: false,
      }),
    ).toBe(true);
  });
});
