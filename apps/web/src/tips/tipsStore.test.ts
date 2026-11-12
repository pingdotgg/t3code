import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const STORAGE_KEY = "t3code:new-thread-tips:v1";

function stubStorage({ refuseWrites = false } = {}) {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuseWrites) throw new DOMException("full", "QuotaExceededError");
      store.set(key, value);
    },
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  vi.stubGlobal("window", {
    localStorage,
    location: { pathname: "/", href: "http://localhost/" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
  vi.stubGlobal("localStorage", localStorage);
  return { read: () => JSON.parse(store.get(STORAGE_KEY) ?? "null") };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("tipsStore", () => {
  it("keeps the time a tip was shown and leaves its event for later when nothing can take it", async () => {
    const storage = stubStorage();
    const { markTipShown } = await import("./tipsStore");
    // No environment is connected, so nothing is claimed and a later visit sends it.
    markTipShown("devices", null);
    expect(storage.read().tips.devices).toEqual({ shownAt: expect.any(Number) });
  });

  it("lets a later unreported use leave an earlier use's completion pending", async () => {
    const storage = stubStorage();
    const { markTipDone } = await import("./tipsStorage");
    markTipDone("voice-input", { at: 1 });
    markTipDone("voice-input", { at: 2, unreported: true });
    expect(storage.read().tips["voice-input"].sent).toBeUndefined();
    markTipDone("mcp-apps", { at: 2, unreported: true });
    expect(storage.read().tips["mcp-apps"].sent).toEqual(["completed"]);
  });

  it("keeps an event's tries when the connection, not the server, failed", async () => {
    stubStorage();
    const { failureKind } = await import("./tipsStore");
    const { EnvironmentRpcUnavailableError } = await import("@t3tools/client-runtime/rpc");
    const cases = [
      [Cause.interrupt(), "unreachable"],
      [
        Cause.fail(
          new EnvironmentRpcUnavailableError({ environmentId: "env-a", message: "offline" }),
        ),
        "unreachable",
      ],
      [Cause.fail({ _tag: "RpcClientError", message: "closed" }), "unreachable"],
      [Cause.die(new Error("Socket is not connected")), "unreachable"],
      [Cause.fail({ _tag: "EnvironmentAuthorizationError", message: "denied" }), "refused"],
      [Cause.die(new Error("Unknown method server.recordTipEvent")), "refused"],
    ] as const;
    for (const [cause, expected] of cases) expect(failureKind({ cause })).toBe(expected);
  });

  it("keeps the first time a tip was hidden when another tab hides it again", async () => {
    const storage = stubStorage();
    const { setTipDismissed } = await import("./tipsStore");
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    setTipDismissed("devices", true, null);
    now.mockReturnValue(2);
    setTipDismissed("devices", true, null);
    expect(storage.read().tips.devices.dismissedAt).toBe(1);
  });

  it("hides tips for remote clients on a machine whose policy forbids them", async () => {
    stubStorage();
    const { isTipAvailable } = await import("./tipsStore");
    const { EnvironmentId } = await import("@t3tools/contracts");
    const environmentId = EnvironmentId.make("env-a");
    const available = (clients: ReadonlyArray<string>) => {
      const managedPolicy = { organization: "Acme", limits: { clients } };
      const sources = {
        providers: new Map(),
        configs: new Map([[environmentId, { managedPolicy }]]),
        canOperate: () => true,
      } as unknown as NonNullable<Parameters<typeof isTipAvailable>[3]>;
      return (["phone-app", "mcp-apps"] as const).map((id) =>
        isTipAvailable(id, environmentId, undefined, sources),
      );
    };
    expect(available(["local"])).toEqual([false, false]);
    expect(available(["local", "remote"])).toEqual([true, true]);
  });

  it("keeps agent tips out of rotation on a connection that cannot send", async () => {
    stubStorage();
    const { isTipAvailable } = await import("./tipsStore");
    const { EnvironmentId } = await import("@t3tools/contracts");
    const environmentId = EnvironmentId.make("env-a");
    const ready = new Set(["claudeAgent", "codex"]);
    const available = (canOperate: boolean) => {
      const sources = {
        providers: new Map(),
        configs: new Map([[environmentId, { environment: { capabilities: { sideChats: true } } }]]),
        canOperate: () => canOperate,
      } as unknown as NonNullable<Parameters<typeof isTipAvailable>[3]>;
      return (["agent-threads", "claude-codex", "side-chats"] as const).map((id) =>
        isTipAvailable(id, environmentId, ready, sources),
      );
    };
    expect(available(false)).toEqual([false, false, false]);
    expect(available(true)).toEqual([true, true, true]);
  });

  it("does not hide a tip or report it when storage refuses the write", async () => {
    stubStorage({ refuseWrites: true });
    const { setTipDismissed } = await import("./tipsStore");
    expect(setTipDismissed("devices", true, null)).toBe(false);
  });
});
