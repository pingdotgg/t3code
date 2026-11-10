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
    relay.event("Target.attachedToTarget", { sessionId: "iframe-session" }, "");
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
    relay.event("Target.attachedToTarget", { sessionId: "iframe-session" }, "");
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
    relay.event("Target.attachedToTarget", { sessionId: "iframe-session" }, "");
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
    relay.receive(
      JSON.stringify({
        id: 6,
        method: "Target.detachFromTarget",
        params: { sessionId: extra },
        sessionId: browserSession,
      }),
    );
    await settle();
    expect(written).toContainEqual({
      method: "Target.detachedFromTarget",
      params: { sessionId: extra, targetId: "GUEST-TARGET" },
      sessionId: browserSession,
    });
  });
});

describe("CDP relay popups", () => {
  const makePopup = (
    targetId: string,
    send: CdpRelayTarget["send"],
    close: () => void = () => {},
    setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
  ): CdpRelayTarget => ({
    ...makeTarget(send, setDownloadDirectory),
    targetId: async () => targetId,
    url: () => `http://localhost:4719/${targetId}`,
    close,
  });
  const resultOf = (written: Array<Record<string, unknown>>, id: number) =>
    written.find((message) => message["id"] === id)!;

  it.each(["announced", "extra"])(
    "revokes popup children when its last %s page session detaches without affecting other targets",
    async (last) => {
      const pageSend = vi.fn(async () => ({}));
      const popupSend = vi.fn(async () => ({}));
      const siblingSend = vi.fn(async () => ({}));
      const closePopup = vi.fn();
      const written: Array<Record<string, unknown>> = [];
      const relay = makeRelay(makeTarget(pageSend), (raw) => written.push(JSON.parse(raw)));
      const popup = relay.addPopup(makePopup("POPUP", popupSend, closePopup));
      const sibling = relay.addPopup(makePopup("SIBLING", siblingSend));
      relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach" }));
      await settle();
      relay.receive(
        JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "POPUP" } }),
      );
      await settle();
      const extra = (resultOf(written, 2)["result"] as { sessionId: string }).sessionId;
      const firstSession = last === "announced" ? extra : "t3-preview-popup-1";
      const lastSession = last === "announced" ? "t3-preview-popup-1" : extra;
      relay.event("Target.attachedToTarget", { sessionId: "opener-child" }, "");
      sibling.event("Target.attachedToTarget", { sessionId: "sibling-child" }, "");
      popup.event("Target.attachedToTarget", { sessionId: "popup-child" }, "");
      popup.event("Target.attachedToTarget", { sessionId: "nested-child" }, "popup-child");
      relay.receive(
        JSON.stringify({
          id: 3,
          method: "Target.detachFromTarget",
          params: { sessionId: firstSession },
        }),
      );
      await settle();
      relay.receive(JSON.stringify({ id: 4, method: "DOM.enable", sessionId: "popup-child" }));
      await settle();
      expect(resultOf(written, 4)).toHaveProperty("result");
      expect(popupSend).toHaveBeenCalledExactlyOnceWith("DOM.enable", {}, "popup-child", undefined);
      const childEvent = {
        method: "Runtime.consoleAPICalled",
        params: {},
        sessionId: "popup-child",
      };
      popup.event(childEvent.method, childEvent.params, childEvent.sessionId);
      expect(written.at(-1)).toEqual(childEvent);
      popupSend.mockClear();

      relay.receive(
        JSON.stringify({
          id: 5,
          method: "Target.detachFromTarget",
          params: { sessionId: lastSession },
        }),
      );
      relay.receive(
        JSON.stringify({
          id: 6,
          method: "Target.detachFromTarget",
          params: { sessionId: "t3-preview-page" },
        }),
      );
      await settle();
      for (const sessionId of [firstSession, lastSession]) {
        expect(written).toContainEqual({
          method: "Target.detachedFromTarget",
          params: { sessionId, targetId: "POPUP" },
        });
      }
      const eventCount = written.length;
      popup.event(childEvent.method, childEvent.params, childEvent.sessionId);
      popup.event("Runtime.consoleAPICalled", {}, "nested-child");
      popup.event("Target.attachedToTarget", { sessionId: "late-child" }, "");
      popup.event("Target.attachedToTarget", { sessionId: "late-nested-child" }, "popup-child");
      popup.event("Page.loadEventFired", {}, "");
      expect(written).toHaveLength(eventCount);
      const detached = [
        lastSession,
        "popup-child",
        "nested-child",
        "late-child",
        "late-nested-child",
      ];
      detached.forEach((sessionId, index) =>
        relay.receive(JSON.stringify({ id: 10 + index, method: "Runtime.evaluate", sessionId })),
      );
      for (const [id, sessionId] of [
        [20, "t3-preview-page"],
        [21, "opener-child"],
        [22, "sibling-child"],
      ])
        relay.receive(JSON.stringify({ id, method: "Page.enable", sessionId }));
      relay.receive(JSON.stringify({ id: 23, method: "Target.getTargets" }));
      await settle();
      detached.forEach((_, index) => expect(resultOf(written, 10 + index)).toHaveProperty("error"));
      expect(popupSend).not.toHaveBeenCalled();
      expect(closePopup).not.toHaveBeenCalled();
      expect(pageSend.mock.calls).toEqual([
        ["Page.enable", {}, undefined, undefined],
        ["Page.enable", {}, "opener-child", undefined],
      ]);
      expect(siblingSend).toHaveBeenCalledExactlyOnceWith(
        "Page.enable",
        {},
        "sibling-child",
        undefined,
      );
      for (const id of [20, 21, 22]) expect(resultOf(written, id)).toHaveProperty("result");
      expect(resultOf(written, 23)["result"]).toMatchObject({
        targetInfos: [
          { targetId: "GUEST-TARGET", attached: true },
          { targetId: "POPUP", attached: false },
          { targetId: "SIBLING", attached: true },
        ],
      });
      popup.remove();
      expect(
        written.filter((message) => message["method"] === "Target.detachedFromTarget"),
      ).toHaveLength(2);
    },
  );

  it.each(["browser", "popup", "child"])(
    "detaches a popup child through its %s session without affecting the other sessions",
    async (source) => {
      const pageSend = vi.fn(async () => ({}));
      const popupSend = vi.fn(async () => ({}));
      const written: Array<Record<string, unknown>> = [];
      const relay = makeRelay(makeTarget(pageSend), (raw) => written.push(JSON.parse(raw)));
      const popup = relay.addPopup(makePopup("POPUP", popupSend));
      relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach" }));
      await settle();
      const popupSession = "t3-preview-popup-1";
      popup.event("Target.attachedToTarget", { sessionId: "parent-frame" }, "");
      popup.event("Target.attachedToTarget", { sessionId: "popup-child" }, "parent-frame");
      popup.event("Target.attachedToTarget", { sessionId: "nested-child" }, "popup-child");
      popup.event("Target.attachedToTarget", { sessionId: "sibling-frame" }, "");
      relay.receive(JSON.stringify({ id: 2, method: "DOM.enable", sessionId: "popup-child" }));
      await settle();
      expect(popupSend).toHaveBeenLastCalledWith("DOM.enable", {}, "popup-child", undefined);

      const sessionId =
        source === "browser" ? undefined : source === "popup" ? popupSession : "parent-frame";
      relay.receive(
        JSON.stringify({
          id: 3,
          method: "Target.detachFromTarget",
          params: { sessionId: "popup-child" },
          sessionId,
        }),
      );
      await settle();
      expect(popupSend).toHaveBeenLastCalledWith(
        "Target.detachFromTarget",
        { sessionId: "popup-child" },
        "parent-frame",
        undefined,
      );
      expect(resultOf(written, 3)).toHaveProperty("result");

      popupSend.mockClear();
      relay.receive(JSON.stringify({ id: 4, method: "DOM.enable", sessionId: "popup-child" }));
      relay.receive(JSON.stringify({ id: 5, method: "Page.enable", sessionId: popupSession }));
      relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "sibling-frame" }));
      relay.receive(JSON.stringify({ id: 7, method: "Page.enable", sessionId: "t3-preview-page" }));
      relay.receive(JSON.stringify({ id: 8, method: "DOM.enable", sessionId: "nested-child" }));
      await settle();
      expect(resultOf(written, 4)).toHaveProperty("error");
      expect(resultOf(written, 8)).toHaveProperty("error");
      const eventCount = written.length;
      popup.event("Runtime.consoleAPICalled", {}, "popup-child");
      popup.event("Runtime.consoleAPICalled", {}, "nested-child");
      popup.event("Target.attachedToTarget", { sessionId: "late-child" }, "popup-child");
      expect(written).toHaveLength(eventCount);
      expect(popupSend.mock.calls).toEqual([
        ["Page.enable", {}, undefined, popupSession],
        ["DOM.enable", {}, "sibling-frame", undefined],
      ]);
      expect(pageSend.mock.calls).toEqual([["Page.enable", {}, undefined, undefined]]);
      for (const id of [5, 6, 7]) expect(resultOf(written, id)).toHaveProperty("result");
    },
  );

  it("announces the page's popups after it, as its popups, and routes them separately", async () => {
    const pageSend = vi.fn(async () => ({}));
    const earlySend = vi.fn(async () => ({}));
    const lateSend = vi.fn(async () => ({}));
    const closeLate = vi.fn();
    const directories: Array<string | null> = [];
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(pageSend), (raw) => written.push(JSON.parse(raw)));
    const early = relay.addPopup(makePopup("EARLY", earlySend));
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: true },
      }),
    );
    relay.receive(JSON.stringify({ id: 2, method: "Target.setAutoAttach", params: {} }));
    await settle();
    const late = relay.addPopup(
      makePopup("LATE", lateSend, closeLate, (directory) => directories.push(directory)),
    );
    await settle();

    const announced = written.filter((m) => m["method"] === "Target.attachedToTarget");
    expect(announced.map((m) => m["params"])).toEqual([
      expect.objectContaining({
        sessionId: "t3-preview-page",
        targetInfo: expect.not.objectContaining({ openerId: expect.anything() }),
      }),
      expect.objectContaining({
        targetInfo: expect.objectContaining({ targetId: "EARLY", openerId: "GUEST-TARGET" }),
      }),
      expect.objectContaining({
        targetInfo: expect.objectContaining({ targetId: "LATE", openerId: "GUEST-TARGET" }),
      }),
    ]);
    const [, earlySession, lateSession] = announced.map(
      (m) => (m["params"] as { sessionId: string }).sessionId,
    );
    // A popup opened after the server chose where downloads go saves there too.
    expect(directories).toEqual(["/srv/artifacts"]);
    expect(lateSend).toHaveBeenCalledWith(
      "Page.setDownloadBehavior",
      { behavior: "default" },
      undefined,
    );

    relay.receive(JSON.stringify({ id: 3, method: "Target.getTargets" }));
    relay.receive(JSON.stringify({ id: 4, method: "Target.attachToBrowserTarget" }));
    await settle();
    expect(
      (resultOf(written, 3)["result"] as { targetInfos: Array<{ targetId: string }> }).targetInfos,
    ).toEqual([
      expect.objectContaining({ targetId: "GUEST-TARGET" }),
      expect.objectContaining({ targetId: "EARLY" }),
      expect.objectContaining({ targetId: "LATE" }),
    ]);
    const browserSession = (resultOf(written, 4)["result"] as { sessionId: string }).sessionId;
    const closedDialog = { result: true, userInput: "" };
    late.event("Page.javascriptDialogOpening", { type: "alert", message: "hello" }, "");
    late.event("Page.javascriptDialogClosed", closedDialog, "");
    relay.receive(
      JSON.stringify({
        id: 5,
        method: "Target.attachToTarget",
        params: { targetId: "LATE", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({ id: 6, method: "Target.closeTarget", params: { targetId: "GUEST-TARGET" } }),
    );
    relay.receive(
      JSON.stringify({ id: 7, method: "Target.attachToTarget", params: { targetId: "OTHER" } }),
    );
    await settle();
    const extra = (resultOf(written, 5)["result"] as { sessionId: string }).sessionId;
    expect(resultOf(written, 6)).toHaveProperty("error");
    expect(resultOf(written, 7)).toHaveProperty("error");

    relay.receive(JSON.stringify({ id: 8, method: "Page.enable", sessionId: earlySession }));
    relay.receive(JSON.stringify({ id: 9, method: "Page.startScreencast", sessionId: extra }));
    relay.receive(JSON.stringify({ id: 10, method: "Page.enable", sessionId: "t3-preview-page" }));
    await settle();
    expect(earlySend.mock.calls.at(-1)).toEqual(["Page.enable", {}, undefined, earlySession]);
    expect(lateSend.mock.calls.at(-1)).toEqual(["Page.startScreencast", {}, undefined, extra]);
    expect(pageSend.mock.calls.at(-1)).toEqual(["Page.enable", {}, undefined, undefined]);

    // The native response predates this CDP session, while popup adoption is waiting.
    written.length = 0;
    relay.receive(JSON.stringify({ id: 14, method: "Page.enable", sessionId: extra }));
    await settle();
    expect(written).toEqual([
      { method: "Page.javascriptDialogClosed", params: closedDialog, sessionId: extra },
      { id: 14, result: {}, sessionId: extra },
    ]);

    const enabling = Promise.withResolvers<object>();
    lateSend.mockImplementationOnce(() => enabling.promise);
    written.length = 0;
    relay.receive(JSON.stringify({ id: 15, method: "Page.enable", sessionId: extra }));
    late.event("Page.javascriptDialogOpening", { type: "confirm", message: "still open" }, "");
    enabling.resolve({});
    await settle();
    expect(
      written.filter((message) => message["method"] === "Page.javascriptDialogClosed"),
    ).toEqual([]);
    expect(resultOf(written, 15)).toMatchObject({ result: {} });

    // A frame's session belongs to the popup whose debugger attached it.
    late.event(
      "Target.attachedToTarget",
      { sessionId: "late-frame", targetInfo: { type: "iframe" } },
      "",
    );
    late.event("Page.javascriptDialogClosed", closedDialog, "");
    late.event("Page.javascriptDialogOpening", { type: "alert", message: "iframe" }, "late-frame");
    written.length = 0;
    relay.receive(JSON.stringify({ id: 16, method: "Page.enable", sessionId: extra }));
    await settle();
    expect(written).toEqual([{ id: 16, result: {}, sessionId: extra }]);
    const closedFrameDialog = { result: false, userInput: "" };
    late.event("Page.javascriptDialogClosed", closedFrameDialog, "late-frame");
    written.length = 0;
    relay.receive(JSON.stringify({ id: 17, method: "Page.enable", sessionId: extra }));
    await settle();
    expect(written).toEqual([
      { method: "Page.javascriptDialogClosed", params: closedFrameDialog, sessionId: extra },
      { id: 17, result: {}, sessionId: extra },
    ]);
    relay.receive(JSON.stringify({ id: 11, method: "DOM.enable", sessionId: "late-frame" }));
    await settle();
    expect(lateSend.mock.calls.at(-1)).toEqual(["DOM.enable", {}, "late-frame", undefined]);

    written.length = 0;
    early.event("Page.loadEventFired", { timestamp: 1 }, "");
    late.event("Page.downloadWillBegin", { guid: "g1", frameId: "LATE" }, "");
    expect(written).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: earlySession },
      { method: "Browser.downloadWillBegin", params: { guid: "g1", frameId: "LATE" } },
    ]);

    relay.receive(
      JSON.stringify({ id: 12, method: "Target.closeTarget", params: { targetId: "LATE" } }),
    );
    await settle();
    expect(closeLate).toHaveBeenCalledOnce();
    written.length = 0;
    late.remove();
    late.event("Page.loadEventFired", {}, "");
    expect(written).toEqual([
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: lateSession, targetId: "LATE" },
      },
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: extra, targetId: "LATE" },
        sessionId: browserSession,
      },
    ]);
    relay.receive(JSON.stringify({ id: 13, method: "Target.getTargets" }));
    await settle();
    expect(
      (resultOf(written, 13)["result"] as { targetInfos: Array<{ targetId: string }> }).targetInfos,
    ).toHaveLength(2);
  });

  it("never announces a popup that closed before the page was", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(vi.fn()), (raw) => written.push(JSON.parse(raw)));
    relay.addPopup(makePopup("GONE", vi.fn())).remove();
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    expect(written.filter((m) => m["method"] !== undefined)).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ sessionId: "t3-preview-page" }),
      }),
    ]);
  });
});

describe("CDP relay downloads", () => {
  it("captures preview downloads without changing the default browser context", async () => {
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
    expect(send.mock.calls).toEqual([
      ["Page.setDownloadBehavior", { behavior: "default" }, undefined],
    ]);
    written.length = 0;
    relay.event("Page.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    relay.event("Page.downloadProgress", { guid: "g1", state: "completed" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
      { method: "Browser.downloadProgress", params: { guid: "g1", state: "completed" } },
    ]);
  });

  it("keeps denial scoped to the preview and restores Electron's save handling when allowed", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const relay = makeRelay(
      makeTarget(send, (directory) => directories.push(directory)),
      () => {},
    );
    for (const [id, behavior] of ["deny", "allowAndName"].entries()) {
      relay.receive(
        JSON.stringify({
          id,
          method: "Browser.setDownloadBehavior",
          params: { behavior, downloadPath: "/srv/artifacts" },
        }),
      );
      await settle();
    }
    expect(directories).toEqual([null, "/srv/artifacts"]);
    expect(send.mock.calls).toEqual([
      ["Page.setDownloadBehavior", { behavior: "deny" }, undefined],
      ["Page.setDownloadBehavior", { behavior: "default" }, undefined],
    ]);
  });

  it("does not publish download events when the connection has disabled them", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = makeRelay(makeTarget(vi.fn(async () => ({}))), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: false },
      }),
    );
    await settle();
    written.length = 0;
    relay.event("Page.downloadWillBegin", { guid: "g1" }, "");
    relay.event("Page.downloadProgress", { guid: "g1", state: "completed" }, "");
    expect(written).toEqual([]);
  });

  it.each(
    [false, true].flatMap((enabled) =>
      ["page", "popup", "removed popup"].map((failure) => ({ enabled, failure })),
    ),
  )(
    "keeps download configuration consistent when $failure rejects (events enabled: $enabled)",
    async ({ enabled, failure }) => {
      const send = vi.fn(async () => ({}));
      const popupSend = vi.fn(async () => ({}));
      const written: Array<Record<string, unknown>> = [];
      let directory: string | null = null;
      let popupDirectory: string | null = null;
      const relay = makeRelay(
        makeTarget(send, (value) => {
          directory = value;
        }),
        (raw) => written.push(JSON.parse(raw)),
      );
      const popup = relay.addPopup({
        ...makeTarget(popupSend, (value) => {
          popupDirectory = value;
        }),
        targetId: async () => "POPUP",
      });
      relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
      for (const [id, eventsEnabled] of [enabled, !enabled].entries()) {
        const pending = Promise.withResolvers<object>();
        if (id === 1)
          (failure === "page" ? send : popupSend).mockImplementationOnce(() => pending.promise);
        relay.receive(
          JSON.stringify({
            id: id + 2,
            method: "Browser.setDownloadBehavior",
            params: {
              behavior: id === 1 && enabled ? "deny" : "allowAndName",
              downloadPath: id === 0 ? "/srv/artifacts" : "/srv/new-artifacts",
              eventsEnabled,
            },
          }),
        );
        if (id === 1) {
          if (failure === "removed popup") popup.remove();
          pending.reject(new Error("Page command rejected"));
        }
        await settle();
      }
      const removed = failure === "removed popup";
      expect(written).toContainEqual(
        removed
          ? { id: 3, result: {} }
          : { id: 3, error: { code: -32000, message: "Page command rejected" } },
      );
      const expectedDirectory = removed
        ? enabled
          ? null
          : "/srv/new-artifacts"
        : "/srv/artifacts";
      expect(directory).toBe(expectedDirectory);
      expect(popupDirectory).toBe("/srv/artifacts");
      if (removed) {
        const lateSend = vi.fn(async () => ({}));
        const lateDirectory = vi.fn();
        relay.addPopup(makeTarget(lateSend, lateDirectory));
        await settle();
        expect(lateDirectory).toHaveBeenCalledExactlyOnceWith(expectedDirectory);
        expect(lateSend).toHaveBeenCalledExactlyOnceWith(
          "Page.setDownloadBehavior",
          { behavior: enabled ? "deny" : "default" },
          undefined,
        );
      }
      written.length = 0;
      relay.event("Page.downloadWillBegin", { guid: "g1" }, "");
      relay.event("Page.downloadProgress", { guid: "g1", state: "completed" }, "");
      expect(written).toEqual(
        (removed ? !enabled : enabled)
          ? [
              { method: "Browser.downloadWillBegin", params: { guid: "g1" } },
              { method: "Browser.downloadProgress", params: { guid: "g1", state: "completed" } },
            ]
          : [],
      );
    },
  );
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
