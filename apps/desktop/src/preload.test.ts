import type { DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const { exposeClerkBridgeMock, exposeInMainWorldMock, invokeMock } = vi.hoisted(() => ({
  exposeClerkBridgeMock: vi.fn(),
  exposeInMainWorldMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@clerk/electron/preload", () => ({
  exposeClerkBridge: exposeClerkBridgeMock,
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock,
  },
  ipcRenderer: {
    invoke: invokeMock,
    on: vi.fn(),
    removeListener: vi.fn(),
    sendSync: vi.fn(),
  },
}));

import {
  GET_MICROPHONE_ACCESS_STATUS_CHANNEL,
  REQUEST_MICROPHONE_ACCESS_CHANNEL,
} from "./ipc/channels.ts";
import "./preload.ts";

describe("desktop preload microphone bridge", () => {
  it("exposes opt-in permission methods without invoking either one during preload", async () => {
    expect(invokeMock).not.toHaveBeenCalled();
    const exposeCall = exposeInMainWorldMock.mock.calls.find(([name]) => name === "desktopBridge");
    expect(exposeCall).toBeDefined();
    const bridge = exposeCall?.[1] as DesktopBridge | undefined;
    expect(bridge?.getMicrophoneAccessStatus).toBeTypeOf("function");
    expect(bridge?.requestMicrophoneAccess).toBeTypeOf("function");
    if (!bridge?.getMicrophoneAccessStatus || !bridge.requestMicrophoneAccess) {
      throw new Error("Expected the desktop microphone permission bridge to be exposed.");
    }

    invokeMock.mockResolvedValueOnce("not-determined").mockResolvedValueOnce("granted");
    await expect(bridge.getMicrophoneAccessStatus()).resolves.toBe("not-determined");
    await expect(bridge.requestMicrophoneAccess()).resolves.toBe("granted");
    expect(invokeMock.mock.calls).toEqual([
      [GET_MICROPHONE_ACCESS_STATUS_CHANNEL],
      [REQUEST_MICROPHONE_ACCESS_CHANNEL],
    ]);
  });
});
