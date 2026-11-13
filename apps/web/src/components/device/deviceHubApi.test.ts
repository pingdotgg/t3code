import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  appendDeviceEventLog,
  DEVICE_EVENT_LOG_LIMIT,
  type DeviceEventLogEntry,
  subscribeDeviceForeground,
} from "./deviceHubApi";

describe("foreground app events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears the last app when it exits and ignores malformed events", () => {
    let source: FakeEventSource;
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      addEventListener(_type: string, listener: (event: { data: string }) => void) {
        this.onmessage = listener;
      }
      close = vi.fn();
      constructor() {
        source = this;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onChange = vi.fn();
    const stop = subscribeDeviceForeground(
      {
        platform: "ios",
        deviceId: "test",
        access: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
      },
      onChange,
    );
    const emit = (data: unknown) => source.onmessage?.({ data: JSON.stringify(data) });
    emit({ bundleId: "com.example.app", pid: 123 });
    emit({ bundleId: null });
    emit({ bundleId: "com.example.other" });
    emit({ bundleId: "" });
    emit({ other: "not app state" });
    expect(onChange.mock.calls.map(([app]) => app)).toEqual([
      { id: "com.example.app", pid: 123 },
      null,
      { id: "com.example.other" },
      null,
    ]);
    stop();
    expect(source!.close).toHaveBeenCalledOnce();
  });
});

describe("event log buffer", () => {
  const entry = (id: number): DeviceEventLogEntry => ({ id, timestamp: "", kind: "", summary: "" });

  it("replaces the log on a reset batch and keeps only the newest entries", () => {
    const full = Array.from({ length: DEVICE_EVENT_LOG_LIMIT }, (_, index) => entry(index));
    const appended = appendDeviceEventLog(full, [entry(DEVICE_EVENT_LOG_LIMIT)], false);
    expect(appended).toHaveLength(DEVICE_EVENT_LOG_LIMIT);
    expect(appended[0]?.id).toBe(1);
    expect(appended.at(-1)?.id).toBe(DEVICE_EVENT_LOG_LIMIT);
    expect(appendDeviceEventLog(full, [entry(7)], true)).toEqual([entry(7)]);
  });
});
