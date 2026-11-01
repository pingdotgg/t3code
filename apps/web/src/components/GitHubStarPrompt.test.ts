import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { toastManager } from "./ui/toast";

const { add, starred } = vi.hoisted(() => ({
  add: vi.fn<typeof toastManager.add>(),
  starred: { value: false, duringCheck: () => {} },
}));
vi.mock("./ui/toast", () => ({ toastManager: { add, close: vi.fn() } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/sourceControl", () => ({ sourceControlEnvironment: { checkStarred: {} } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async () => {
    starred.duringCheck();
    return { _tag: "Success", value: starred.value };
  },
}));

const environmentId = EnvironmentId.make("environment-1");

function setup({ sent = 0, writable = true, alreadyStarred = false } = {}) {
  add.mockReset();
  starred.value = alreadyStarred;
  starred.duringCheck = () => {};
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
  return store;
}

// A fresh module import stands in for an app reload; storage survives it.
async function startSession() {
  vi.resetModules();
  const session = await import("./GitHubStarPrompt");
  return { send: () => session.recordPromptSent(environmentId) };
}

describe("recordPromptSent", () => {
  it("asks after five prompts, once per session, and never again once closed", async () => {
    setup();
    let session = await startSession();
    for (let sent = 0; sent < 5; sent++) await session.send();
    expect(add).not.toHaveBeenCalled();

    await session.send();
    await session.send();
    expect(add).toHaveBeenCalledOnce();

    session = await startSession();
    await session.send();
    expect(add).toHaveBeenCalledTimes(2);

    add.mock.lastCall?.[0].onClose?.();
    session = await startSession();
    for (let sent = 0; sent < 10; sent++) await session.send();
    expect(add).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("never asks when a dismissal could not be saved", async () => {
    setup({ sent: 5, writable: false });
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never asks once the environment's GitHub account starred the repo", async () => {
    setup({ sent: 5, alreadyStarred: true });
    await (await startSession()).send();
    starred.value = false;
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never asks when another tab dismisses it during the star check", async () => {
    const store = setup({ sent: 5 });
    starred.duringCheck = () => store.set("t3code:github-star-prompt:dismissed", "true");
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
