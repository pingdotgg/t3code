import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  activateWindowsForegroundWithApi,
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

  it("rejects malformed native handles", () => {
    const api = makeApi({});

    assert.throws(() => activateWindowsForegroundWithApi(Buffer.alloc(6), api));
    assert.lengthOf(api.getForegroundWindow.mock.calls, 0);
  });
});
