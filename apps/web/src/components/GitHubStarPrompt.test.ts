import { describe, expect, it, vi } from "vite-plus/test";

import type { toastManager } from "./ui/toast";

const { add } = vi.hoisted(() => ({ add: vi.fn<typeof toastManager.add>() }));
vi.mock("./ui/toast", () => ({ toastManager: { add, close: vi.fn() } }));

function setup({ sent = 0, writable = true } = {}) {
  add.mockReset();
  const store = new Map([["t3code:github-star-prompt:sent", String(sent)]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (!writable) throw new Error("QuotaExceededError");
        store.set(key, value);
      },
    },
  });
}

// A fresh module import stands in for an app reload; storage survives it.
async function startSession() {
  vi.resetModules();
  return import("./GitHubStarPrompt");
}

describe("recordPromptSent", () => {
  it("asks after five prompts, once per session, and never again once closed", async () => {
    setup();
    let session = await startSession();
    for (let sent = 0; sent < 5; sent++) session.recordPromptSent();
    expect(add).not.toHaveBeenCalled();

    session.recordPromptSent();
    session.recordPromptSent();
    expect(add).toHaveBeenCalledOnce();

    session = await startSession();
    session.recordPromptSent();
    expect(add).toHaveBeenCalledTimes(2);

    add.mock.lastCall?.[0].onClose?.();
    session = await startSession();
    for (let sent = 0; sent < 10; sent++) session.recordPromptSent();
    expect(add).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("never asks when a dismissal could not be saved", async () => {
    setup({ sent: 5, writable: false });
    const session = await startSession();
    session.recordPromptSent();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
