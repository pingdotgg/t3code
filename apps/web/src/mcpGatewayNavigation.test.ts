import { describe, expect, it, vi } from "vite-plus/test";
import { openDesktopGatewayThread } from "./mcpGatewayNavigation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("desktop gateway navigation", () => {
  it("waits for remote navigation, then for the native window reveal", async () => {
    const navigation = deferred();
    const reveal = deferred();
    const router = { navigate: vi.fn(() => navigation.promise) };
    const desktop = { revealWindow: vi.fn(() => reveal.promise) };
    let finished = false;
    const result = openDesktopGatewayThread(router, desktop, "dev-box", "chat").then(() => {
      finished = true;
    });
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "dev-box", threadId: "chat" },
    });
    expect(desktop.revealWindow).not.toHaveBeenCalled();
    navigation.resolve();
    await Promise.resolve();
    expect(desktop.revealWindow).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    reveal.resolve();
    await result;
    expect(finished).toBe(true);
  });

  it("does not navigate when desktop focus is unavailable", async () => {
    const router = { navigate: vi.fn(async () => {}) };
    await expect(openDesktopGatewayThread(router, undefined, "dev-box", "chat")).rejects.toThrow(
      "unavailable",
    );
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("propagates navigation and native reveal failures", async () => {
    const desktop = {
      revealWindow: vi.fn(async () => {
        throw new Error("window closed");
      }),
    };
    await expect(
      openDesktopGatewayThread(
        {
          navigate: async () => {
            throw new Error("route failed");
          },
        },
        desktop,
        "dev-box",
        "chat",
      ),
    ).rejects.toThrow("route failed");
    expect(desktop.revealWindow).not.toHaveBeenCalled();
    await expect(
      openDesktopGatewayThread({ navigate: async () => {} }, desktop, "dev-box", "chat"),
    ).rejects.toThrow("window closed");
  });
});

it("opens the Agents board before revealing the desktop", async () => {
  const { openDesktopGatewayAgents } = await import("./mcpGatewayNavigation");
  const navigation = deferred();
  const router = { navigate: vi.fn(() => navigation.promise) };
  const desktop = { revealWindow: vi.fn(async () => {}) };
  const result = openDesktopGatewayAgents(router, desktop);
  expect(router.navigate).toHaveBeenCalledWith({ to: "/agents" });
  expect(desktop.revealWindow).not.toHaveBeenCalled();
  navigation.resolve();
  await result;
  expect(desktop.revealWindow).toHaveBeenCalledOnce();
});
