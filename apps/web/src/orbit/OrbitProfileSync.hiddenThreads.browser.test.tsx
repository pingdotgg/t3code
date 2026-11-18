import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { recordOrbitPaired, setEnvironmentProvider } from "./environmentProvider";
import { OrbitProfileSync, syncOrbitProfileNow } from "./OrbitProfileSync";
import { isSidebarHiddenThread } from "./sidebarHiddenThreads.logic";
import { useSidebarHiddenThreads } from "./sidebarHiddenThreads";

const hidden = (id: string) =>
  isSidebarHiddenThread(useSidebarHiddenThreads.getState().marks, { environmentId: "clone", id });

describe("OrbitProfileSync and the sidebar's hidden threads", () => {
  it("keeps Orbit rows waiting through Orbit off and on during a slow /me", async () => {
    window.localStorage.clear();
    setEnvironmentProvider("orbit");
    recordOrbitPaired("clone");
    let profile: object | null = null;
    const pendingMe: Array<() => void> = [];
    let deferMe = false;
    const reply = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }), error: null });
    const send = vi.fn(async (request: { method: string; path: string }) => {
      if (request.path === "/environments") return reply([]);
      if (request.path === "/me") {
        if (deferMe) await new Promise<void>((resolve) => pendingMe.push(resolve));
        return reply({ id: 1, name: "mac", profile });
      }
      return { status: 503, body: null, error: null };
    });
    using _bridge = stubGlobal("desktopBridge", { orbitGatewaySend: send });
    await using _screen = await render(<OrbitProfileSync />, { router: false }); // no routes used

    // Confirmed unbound: Orbit rows show.
    await vi.waitFor(() => expect(useSidebarHiddenThreads.getState().active).toBe("none"));
    expect(hidden("row")).toBe(false);

    // A run waits on /me while Orbit goes off and on; the queued run coalesces the off spell.
    deferMe = true;
    const run = syncOrbitProfileNow();
    await vi.waitFor(() => expect(pendingMe).toHaveLength(1));
    setEnvironmentProvider("default");
    setEnvironmentProvider("orbit");
    // Unbound is not a cached profile: rows wait for the fresh /me.
    expect(hidden("row")).toBe(true);
    pendingMe.shift()!();
    await vi.waitFor(() => expect(pendingMe).toHaveLength(1));
    // The stale reply applied nothing; the fresh /me is still pending.
    expect(hidden("row")).toBe(true);
    pendingMe.shift()!();
    await run;
    await vi.waitFor(() => expect(useSidebarHiddenThreads.getState().active).toBe("none"));
    expect(hidden("row")).toBe(false);

    // A bound profile whose marks are cached keeps them at once through the same toggle.
    window.localStorage.setItem("t3code:sidebar-hidden-threads:v2:agreed:7", '["clone:hidden"]');
    profile = { id: 7, name: "Nick", settings_version: 0, updated_at: "" };
    deferMe = false;
    await syncOrbitProfileNow();
    expect(useSidebarHiddenThreads.getState().active).toBe("7");
    deferMe = true;
    const second = syncOrbitProfileNow();
    await vi.waitFor(() => expect(pendingMe).toHaveLength(1));
    setEnvironmentProvider("default");
    expect(hidden("hidden")).toBe(false);
    setEnvironmentProvider("orbit");
    expect(hidden("hidden")).toBe(true);
    expect(hidden("row")).toBe(false);
    pendingMe.shift()!();
    await vi.waitFor(() => expect(pendingMe).toHaveLength(1));
    pendingMe.shift()!();
    await second;
  });
});
