import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  activateWindowsForegroundWithApi,
  isWindowsShellHostedForegroundWithApi,
  type WindowsForegroundApi,
} from "./WindowsForeground.ts";

function nativeHandle(value: bigint, bytes = 8): Buffer {
  const handle = Buffer.alloc(bytes);
  if (bytes === 8) handle.writeBigUInt64LE(value);
  else handle.writeUInt32LE(Number(value));
  return handle;
}

function makeApi(input: {
  readonly foregroundWindow?: bigint;
  readonly currentThreadId?: number;
  readonly foregroundThreadId?: number;
  readonly attached?: boolean;
  readonly activated?: boolean;
}) {
  return {
    getCurrentThreadId: vi.fn(() => input.currentThreadId ?? 10),
    getForegroundWindow: vi.fn(() => input.foregroundWindow ?? 99n),
    getWindowClassName: vi.fn(() => "Chrome_WidgetWin_1"),
    getWindowThreadId: vi.fn(() => input.foregroundThreadId ?? 20),
    getWindowThreadAndProcessId: vi.fn(() => ({
      threadId: input.foregroundThreadId ?? 20,
      processId: 500,
    })),
    getWindowText: vi.fn(() => ""),
    getWindowRect: vi.fn(() => undefined),
    getProcessImagePath: vi.fn(() => ""),
    isKeyDown: vi.fn(() => false),
    attachThreadInput: vi.fn((_source, _target, attach) =>
      attach ? (input.attached ?? true) : true,
    ),
    setForegroundWindow: vi.fn(() => input.activated ?? true),
  } satisfies WindowsForegroundApi;
}

describe("Windows foreground activation", () => {
  it.each([4, 8])("activates a %i-byte native window handle", (bytes) => {
    const api = makeApi({});
    const handle = nativeHandle(41n, bytes);

    assert.isTrue(activateWindowsForegroundWithApi(handle, api));

    assert.deepEqual(api.attachThreadInput.mock.calls, [
      [10, 20, true],
      [10, 20, false],
    ]);
    assert.deepEqual(api.setForegroundWindow.mock.calls, [[41n]]);
  });

  it("does not disturb input queues when T3 is already foreground", () => {
    const api = makeApi({ foregroundWindow: 41n });

    assert.isTrue(activateWindowsForegroundWithApi(nativeHandle(41n), api));

    assert.lengthOf(api.getCurrentThreadId.mock.calls, 0);
    assert.lengthOf(api.attachThreadInput.mock.calls, 0);
    assert.lengthOf(api.setForegroundWindow.mock.calls, 0);
  });

  it("does not attach a thread to itself", () => {
    const api = makeApi({ currentThreadId: 20, foregroundThreadId: 20 });

    assert.isTrue(activateWindowsForegroundWithApi(nativeHandle(41n), api));

    assert.lengthOf(api.attachThreadInput.mock.calls, 0);
    assert.deepEqual(api.setForegroundWindow.mock.calls, [[41n]]);
  });

  it("uses SetForegroundWindow's result as the activation receipt", () => {
    const api = makeApi({ activated: false });

    assert.isFalse(activateWindowsForegroundWithApi(nativeHandle(41n), api));

    assert.deepEqual(api.attachThreadInput.mock.calls, [
      [10, 20, true],
      [10, 20, false],
    ]);
  });

  it("still asks Windows directly when the input queues cannot be attached", () => {
    const api = makeApi({ attached: false });

    assert.isTrue(activateWindowsForegroundWithApi(nativeHandle(41n), api));

    assert.deepEqual(api.attachThreadInput.mock.calls, [[10, 20, true]]);
    assert.deepEqual(api.setForegroundWindow.mock.calls, [[41n]]);
  });

  it("rejects malformed native handles", () => {
    const api = makeApi({});

    assert.throws(() => activateWindowsForegroundWithApi(Buffer.alloc(6), api));
    assert.lengthOf(api.getForegroundWindow.mock.calls, 0);
  });

  it("recognizes a shell-hosted foreground window", () => {
    const api = makeApi({});
    api.getWindowClassName.mockReturnValue("ApplicationFrameWindow");

    assert.isTrue(isWindowsShellHostedForegroundWithApi(api));
    assert.deepEqual(api.getWindowClassName.mock.calls, [[99n]]);
  });

  it("does not classify ordinary or missing foreground windows as shell-hosted", () => {
    const ordinary = makeApi({});
    const missing = makeApi({ foregroundWindow: 0n });

    assert.isFalse(isWindowsShellHostedForegroundWithApi(ordinary));
    assert.isFalse(isWindowsShellHostedForegroundWithApi(missing));
    assert.lengthOf(missing.getWindowClassName.mock.calls, 0);
  });
});
