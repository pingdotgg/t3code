import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Cookie,
} from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makePage = (detach: () => void) => {
  let closed = false;
  const page = Object.assign(new NodeEvents.EventEmitter(), {
    close: async () => {
      if (closed) return;
      closed = true;
      detach();
      page.emit("close", page);
    },
  });
  return page;
};

const makeContext = () => {
  const pages: ReturnType<typeof makePage>[] = [];
  let closed = false;
  const context = Object.assign(new NodeEvents.EventEmitter(), {
    pages: vi.fn(() => [...pages]),
    cookies: vi.fn(async (): Promise<Cookie[]> => []),
    addCookies: vi.fn(async (_cookies: Cookie[]) => {}),
    newPage: vi.fn(async () => {
      const page = makePage(() => pages.splice(pages.indexOf(page), 1));
      pages.push(page);
      context.emit("page", page);
      return page;
    }),
    isClosed: () => closed,
    close: vi.fn(async (): Promise<void> => {
      if (closed) return;
      closed = true;
      while (pages[0]) await pages[0].close();
      context.emit("close", context);
    }),
  });
  return context;
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    created: contexts,
    contexts: () => contexts.filter((context) => !context.isClosed()),
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

const withLauncher = () => {
  const release = vi.fn(async () => {});
  return {
    release,
    configuration: {
      ...options(),
      launcher: vi.fn(async (executable: string) => ({ path: `${executable}-launcher`, release })),
    },
  };
};

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("closes the shared browser only after it holds no context for the idle period", async () => {
    vi.useFakeTimers();
    try {
      const first = makeBrowser();
      const second = makeBrowser();
      launches.launch
        .mockResolvedValueOnce(first as unknown as Browser)
        .mockResolvedValueOnce(second as unknown as Browser);
      const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
      const agent = await pool.contextFor("default", "agent");
      await pool.scratchPage();
      await agent.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await first.created[1]!.close();
      await vi.advanceTimersByTimeAsync(9);
      const next = await pool.contextFor("default", "next");
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await next.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).toHaveBeenCalledOnce();
      await pool.contextFor("default", "later");
      expect(launches.launch).toHaveBeenCalledTimes(2);
      expect(second.newContext).toHaveBeenCalledOnce();
      await pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a scratch context when creating its page fails", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const peer = await pool.contextFor("default", "peer");
    const context = await browser.newContext();
    const failure = new Error("newPage failed");
    browser.created[1]!.newPage.mockRejectedValueOnce(failure);
    browser.newContext.mockResolvedValueOnce(context);
    try {
      await expect(pool.scratchPage()).rejects.toBe(failure);
      expect(context.close).toHaveBeenCalledOnce();
      expect(browser.contexts()).toEqual([peer]);
      expect(peer.close).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
    } finally {
      await pool.close();
    }
  });

  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    const started = Promise.withResolvers<void>();
    launches.launch.mockImplementation(() => {
      started.resolve();
      return launch.promise;
    });
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await started.promise;
    // Playwright may retry the same path until the launch settles.
    expect(release).not.toHaveBeenCalled();
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executablePath: "/test/chromium-launcher" }),
    );
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.created) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium-launcher" }),
    );
    expect(release).toHaveBeenCalledTimes(2);
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("diagnoses a launcher failure against the real executable", async () => {
    const diagnosed = new Error("diagnosed");
    const diagnose = vi.fn(async () => diagnosed);
    const pool = new ServerBrowserContexts({
      ...options(),
      diagnose,
      launcher: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    await expect(pool.contextFor("default", "agent")).rejects.toBe(diagnosed);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("/test/chromium", expect.any(Error));
    expect(launches.launch).not.toHaveBeenCalled();
  });

  it("creates no launcher for a profile whose storage cannot be created", async () => {
    launches.mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const { configuration } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    await expect(pool.contextFor("work/team")).rejects.toThrow("EACCES");
    expect(configuration.launcher).not.toHaveBeenCalled();
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.created[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("waits for the context to close when the same profile is cleared concurrently", async () => {
    const human = makeContext();
    const closed = Promise.withResolvers<void>();
    human.close.mockImplementation(async () => closed.promise);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work/team");

    const first = pool.clearProfile("work/team");
    const second = pool.clearProfile("work/team");
    const deletionsBeforeClose = launches.rm.mock.calls.length;
    closed.resolve();
    await Promise.all([first, second]);

    expect(deletionsBeforeClose).toBe(0);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.created[0]?.close).toHaveBeenCalled();
  });
  it("closes a profile's browser once it has had no open pages for the idle period", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const idle = makeContext();
    const fresh = makeContext();
    launches.persistent
      .mockResolvedValueOnce(idle as unknown as BrowserContext)
      .mockResolvedValueOnce(fresh as unknown as BrowserContext);
    const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
    await (await (await pool.contextFor("default")).newPage()).close();
    await vi.advanceTimersByTimeAsync(5);
    const page = await (await pool.contextFor("default")).newPage();
    await vi.advanceTimersByTimeAsync(10);
    expect(idle.close, "closed a profile with an open page").not.toHaveBeenCalled();
    await page.close();
    await vi.advanceTimersByTimeAsync(9);
    expect(idle.close, "closed a profile before the idle period").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.close, "profile browser outlived its last page").toHaveBeenCalledTimes(1);
    expect(await pool.contextFor("default")).toBe(fresh);
    await pool.close();
  });

  it("keeps a profile's session cookies across an idle close until the profile is cleared", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const session: Cookie = {
      name: "sess",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    };
    const [idle, reopened, cleared] = [makeContext(), makeContext(), makeContext()];
    idle.cookies.mockResolvedValue([session, { ...session, name: "persist", expires: 4e9 }]);
    reopened.cookies.mockResolvedValue([session]);
    for (const context of [idle, reopened, cleared]) {
      launches.persistent.mockResolvedValueOnce(context as unknown as BrowserContext);
    }
    const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
    await pool.contextFor("default");
    await vi.advanceTimersByTimeAsync(10);
    expect(await pool.contextFor("default")).toBe(reopened);
    expect(reopened.addCookies).toHaveBeenCalledExactlyOnceWith([session]);
    await vi.advanceTimersByTimeAsync(10);
    expect(reopened.close).toHaveBeenCalledTimes(1);
    await pool.clearProfile("default");
    expect(launches.rm).toHaveBeenCalledOnce();
    expect(await pool.contextFor("default")).toBe(cleared);
    expect(cleared.addCookies).not.toHaveBeenCalled();
    await pool.close();
  });

  it("relaunches an idle-closed profile only after its previous browser has exited", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const idle = makeContext();
    const exited = Promise.withResolvers<void>();
    idle.close.mockImplementationOnce(() => exited.promise);
    launches.persistent
      .mockResolvedValueOnce(idle as unknown as BrowserContext)
      .mockResolvedValueOnce(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
    await pool.contextFor("default");
    await vi.advanceTimersByTimeAsync(10);
    const reopening = pool.contextFor("default");
    await vi.advanceTimersByTimeAsync(0);
    expect(launches.persistent).toHaveBeenCalledTimes(1);
    exited.resolve();
    await reopening;
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("finishes shutdown only after an idle shared browser has exited", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const browser = makeBrowser();
    const exited = Promise.withResolvers<void>();
    browser.close.mockImplementationOnce(() => exited.promise);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
    await (await pool.contextFor("default", "agent")).close();
    await vi.advanceTimersByTimeAsync(10);
    expect(browser.close).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = pool.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed, "shutdown resolved while the shared browser was exiting").toBe(false);
    exited.resolve();
    await closing;
  });
});
