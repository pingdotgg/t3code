import { describe, expect, it, vi } from "vite-plus/test";

import { createCdpRelayConnection, type CdpRelayTarget } from "./CdpRelay.ts";

const makeTarget = (
  send: CdpRelayTarget["send"],
  setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
): CdpRelayTarget => ({
  send,
  targetId: async () => "GUEST-TARGET",
  url: () => "http://localhost:4719/",
  title: () => "Fixture",
  userAgent: () => "Electron",
  setDownloadDirectory,
});

const makeRelay = (target: CdpRelayTarget, write: (raw: string) => void) =>
  createCdpRelayConnection(target, write, () => {});

// Each relay reply resolves after a few microtasks; one macrotask lets them all land.
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("CDP relay", () => {
  it("announces only the tab's page, under its real target id", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(vi.fn()), (raw) => written.push(JSON.parse(raw)));
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.createTarget", params: {} }));
    await settle();
    const attach = written.findIndex((message) => message["id"] === 1);
    expect(written.slice(attach, attach + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: "Target.attachedToTarget",
        params: expect.objectContaining({
          sessionId: "t3-preview-page",
          targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" }),
        }),
      },
    ]);
    expect(written).toContainEqual({
      id: 2,
      error: expect.objectContaining({ message: expect.stringContaining("createTarget") }),
    });
  });

  it("forwards page commands to the tab and lets a slow one finish last", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(send), (raw) => written.push(JSON.parse(raw)));
    relay.receive(
      JSON.stringify({ id: 5, method: "Page.captureScreenshot", sessionId: "t3-preview-page" }),
    );
    relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "iframe-session" }));
    pending[1]!();
    await settle();
    expect(written).toEqual([
      { id: 6, result: { method: "DOM.enable" }, sessionId: "iframe-session" },
    ]);
    pending[0]!();
    await settle();
    expect(send).toHaveBeenNthCalledWith(1, "Page.captureScreenshot", {}, undefined, undefined);
    expect(send).toHaveBeenNthCalledWith(2, "DOM.enable", {}, "iframe-session", undefined);
    expect(written.at(-1)).toEqual({
      id: 5,
      result: { method: "Page.captureScreenshot" },
      sessionId: "t3-preview-page",
    });
  });

  it("resumes paused child frames, so cross-site iframes run", async () => {
    const send = vi.fn(async () => ({}));
    const relay = makeRelay(makeTarget(send), () => {});
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "t3-preview-page",
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "iframe-session",
      }),
    );
    await settle();
    expect(send.mock.calls).toEqual([
      ["Runtime.runIfWaitingForDebugger", {}, "iframe-session", undefined],
    ]);
  });

  // Playwright enables focus emulation on every page it connects to, and Chromium then
  // counts the guest as captured: a preview the panel hides keeps its timers unthrottled.
  it("acknowledges Playwright's focus emulation without forcing it onto the guest", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(send), (raw) => written.push(JSON.parse(raw)));
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
        sessionId: "t3-preview-page",
      }),
    );
    await settle();
    expect(written).toEqual([{ id: 1, result: {}, sessionId: "t3-preview-page" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("routes tab events to the page session once the page is announced", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(vi.fn()), (raw) => written.push(JSON.parse(raw)));
    relay.event("Page.loadEventFired", {}, undefined);
    expect(written).toEqual([]);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");
    relay.event("Runtime.consoleAPICalled", {}, "iframe-session");
    expect(written.slice(-2)).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "t3-preview-page" },
      { method: "Runtime.consoleAPICalled", params: {}, sessionId: "iframe-session" },
    ]);
  });
});

describe("CDP relay extra sessions", () => {
  it("gives a second page session the page's commands and events", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(send), (raw) => written.push(JSON.parse(raw)));
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await settle();
    const browserSession = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({
        id: 3,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: "SOMETHING-ELSE" },
        sessionId: browserSession,
      }),
    );
    await settle();
    const extra = (written.find((m) => m["id"] === 3)!["result"] as { sessionId: string })
      .sessionId;
    expect(written.find((m) => m["id"] === 4)).toHaveProperty("error");
    relay.receive(JSON.stringify({ id: 5, method: "Page.startScreencast", sessionId: extra }));
    await settle();
    expect(send).toHaveBeenLastCalledWith("Page.startScreencast", {}, undefined, extra);
    written.length = 0;
    relay.event("Page.screencastFrame", { data: "x" }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["t3-preview-page", extra]);
  });
});

describe("CDP relay downloads", () => {
  it("applies the server's download directory and reports downloads on the root session", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(
      makeTarget(send, (directory) => directories.push(directory)),
      (raw) => written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          browserContextId: "t3-preview",
          downloadPath: "/srv/artifacts",
          eventsEnabled: true,
        },
      }),
    );
    await settle();
    expect(directories).toEqual(["/srv/artifacts"]);
    expect(send).toHaveBeenCalledWith(
      "Browser.setDownloadBehavior",
      { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: true },
      undefined,
    );
    written.length = 0;
    relay.event("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
    ]);
  });
});

describe("CDP relay payload budget", () => {
  // 2,048 references to one 40 KiB string: about 80 MiB once serialized, little memory here.
  const oversized = Array(2048).fill("x".repeat(40 * 1024));

  it("fails only an oversized reply and still returns a large screenshot", async () => {
    const screenshot = "A".repeat(16 * 1024 * 1024);
    const send = vi.fn(async (method: string) =>
      method === "DOM.getDocument" ? { nodes: oversized } : { data: screenshot },
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(send), (raw) => written.push(JSON.parse(raw)));
    relay.receive(
      JSON.stringify({ id: 1, method: "DOM.getDocument", sessionId: "t3-preview-page" }),
    );
    relay.receive(
      JSON.stringify({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page" }),
    );
    await settle();

    const replies = written.map(({ id, error, result }) => ({
      id,
      error,
      size: (result as { data?: string } | undefined)?.data?.length,
    }));
    expect(replies).toEqual([
      { id: 1, error: { code: -32000, message: "CDP payload too large" }, size: undefined },
      { id: 2, error: undefined, size: screenshot.length },
    ]);
  });

  it.each([
    { args: oversized },
    { args: "\u0001".repeat(12 * 1024 * 1024) },
    { args: Array(2_700_000).fill(-0.0000010000000000000002) },
  ])("closes instead of dropping an oversized event (%#)", async ({ args }) => {
    const written: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const relay = createCdpRelayConnection(
      makeTarget(vi.fn()),
      (raw) => written.push(JSON.parse(raw)),
      close,
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    written.length = 0;

    relay.event("Runtime.consoleAPICalled", { args }, "");
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");

    relay.receive(JSON.stringify({ id: 2, method: "Target.setAutoAttach" }));
    expect(close).toHaveBeenCalledOnce();
    expect(written.map((message) => message["method"])).toEqual([]);
  });
});
