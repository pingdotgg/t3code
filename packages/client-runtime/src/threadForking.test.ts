import { ProviderDriverKind, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  releaseForkActionLock,
  supportsSelectedResponseFork,
  tryAcquireForkActionLock,
  type ForkActionLock,
} from "./threadForking.js";

describe("supportsSelectedResponseFork", () => {
  it("only enables providers with an exact historical fork primitive", () => {
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("codex"))).toBe(true);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("claudeAgent"))).toBe(true);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("opencode"))).toBe(true);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("cursor"))).toBe(false);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("grok"))).toBe(false);
    expect(supportsSelectedResponseFork(null)).toBe(false);
  });
});

describe("fork action lock", () => {
  it("rejects a second action until the first one releases", () => {
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const lock: ForkActionLock = { current: null };

    expect(tryAcquireForkActionLock(lock, firstTurnId)).toBe(true);
    expect(tryAcquireForkActionLock(lock, secondTurnId)).toBe(false);
    expect(lock.current).toBe(firstTurnId);

    releaseForkActionLock(lock, secondTurnId);
    expect(lock.current).toBe(firstTurnId);
    releaseForkActionLock(lock, firstTurnId);

    expect(tryAcquireForkActionLock(lock, secondTurnId)).toBe(true);
    expect(lock.current).toBe(secondTurnId);
  });
});
