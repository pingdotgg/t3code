import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
const flushComposerDrafts = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return {
        remove: () => {
          appStateListeners.delete(listener);
        },
      };
    },
  },
}));

vi.mock("./use-composer-drafts", () => ({
  flushComposerDrafts,
}));

import { installComposerDraftForegroundFlush } from "./composer-draft-foreground-flush";

function emitAppState(state: string) {
  for (const listener of appStateListeners) listener(state);
}

afterEach(() => {
  appStateListeners.clear();
  flushComposerDrafts.mockClear();
});

describe("composer draft foreground flush", () => {
  it("commits pending drafts when the app leaves the foreground", () => {
    const dispose = installComposerDraftForegroundFlush();

    emitAppState("inactive");
    emitAppState("active");
    emitAppState("background");
    expect(flushComposerDrafts).toHaveBeenCalledTimes(2);

    dispose();
    emitAppState("inactive");
    expect(flushComposerDrafts).toHaveBeenCalledTimes(2);
  });
});
