import type { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearPendingSettingsScrollRestore,
  consumePendingSettingsScrollRestore,
  markPendingSettingsScrollRestore,
  resolveSettingsScrollRestoreThreadId,
} from "./settingsScrollRestore";

const asThreadId = (value: string) => value as ThreadId;

describe("settingsScrollRestore", () => {
  afterEach(() => {
    clearPendingSettingsScrollRestore();
  });

  it("extracts the thread id from a hash route href", () => {
    expect(resolveSettingsScrollRestoreThreadId("#/thread-1?diff=1#panel")).toBe("thread-1");
  });

  it("ignores non-thread settings restore targets", () => {
    expect(resolveSettingsScrollRestoreThreadId("#/settings")).toBeNull();
    expect(resolveSettingsScrollRestoreThreadId("#/")).toBeNull();
  });

  it("consumes the pending settings restore only once for the matching thread", () => {
    markPendingSettingsScrollRestore(asThreadId("thread-1"));

    expect(consumePendingSettingsScrollRestore(asThreadId("thread-2"))).toBe(false);
    expect(consumePendingSettingsScrollRestore(asThreadId("thread-1"))).toBe(true);
    expect(consumePendingSettingsScrollRestore(asThreadId("thread-1"))).toBe(false);
  });
});
