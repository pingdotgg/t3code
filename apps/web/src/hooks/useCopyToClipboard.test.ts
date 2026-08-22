import type { Dispatch, SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];

  const nextIndex = () => cursor++;
  const unmount = () => {
    for (const slot of slots) {
      if (
        typeof slot === "object" &&
        slot !== null &&
        "effectCleanup" in slot &&
        typeof slot.effectCleanup === "function"
      ) {
        slot.effectCleanup();
        slot.effectCleanup = undefined;
      }
    }
  };

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      unmount();
      cursor = 0;
      slots = [];
    },
    unmount,
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useEffect(effect: () => void | (() => void)): void {
      const index = nextIndex();
      if (slots[index] === undefined) {
        slots[index] = { effectCleanup: effect() };
      }
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (slots[index] === undefined) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (slots[index] === undefined) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  useCopyToClipboard,
  writeTextToClipboard,
} from "./useCopyToClipboard";

async function flushClipboardWrite(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  hooks.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("writeTextToClipboard", () => {
  it("reports unavailable clipboard support with structural context", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "plan",
    });
    expect((error as Error).message).not.toContain("plan contents");
  });

  it("preserves the exact clipboard failure without exposing copied contents", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });

  it("keeps empty values as a no-op when clipboard support is available", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("writes the complete multiline value without transforming it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const diagnostic = "Provider failed\ncaused by: socket closed\nrequest id: abc-123";

    await expect(writeTextToClipboard(diagnostic, "error-message")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith(diagnostic);
  });
});

describe("useCopyToClipboard", () => {
  it("shows copied state only after success and resets it after the timeout", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onCopy = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const options = { timeout: 1000, onCopy };

    hooks.beginRender();
    const initial = useCopyToClipboard<string>(options);
    initial.copyToClipboard("complete diagnostic", "thread-a");
    await flushClipboardWrite();

    hooks.beginRender();
    expect(useCopyToClipboard<string>(options).isCopied).toBe(true);
    expect(onCopy).toHaveBeenCalledWith("thread-a");

    vi.advanceTimersByTime(1000);
    hooks.beginRender();
    expect(useCopyToClipboard<string>(options).isCopied).toBe(false);
  });

  it("clears copied feedback when a repeat attempt fails", async () => {
    vi.useFakeTimers();
    const cause = new Error("clipboard permission revoked");
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(cause);
    const onError = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const options = { timeout: 1000, target: "error-message", onError };

    hooks.beginRender();
    let current = useCopyToClipboard<string>(options);
    current.copyToClipboard("first diagnostic", "thread-a");
    await flushClipboardWrite();

    hooks.beginRender();
    current = useCopyToClipboard<string>(options);
    expect(current.isCopied).toBe(true);
    current.copyToClipboard("second diagnostic", "thread-a");

    hooks.beginRender();
    expect(useCopyToClipboard<string>(options).isCopied).toBe(false);
    await flushClipboardWrite();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ cause, target: "error-message" }),
      "thread-a",
    );
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores stale completions from an earlier copy attempt", async () => {
    let resolveFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const writeText = vi.fn().mockReturnValueOnce(firstWrite).mockResolvedValueOnce(undefined);
    const onCopy = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const options = { timeout: 0, onCopy };

    hooks.beginRender();
    const current = useCopyToClipboard<string>(options);
    current.copyToClipboard("older diagnostic", "older");
    current.copyToClipboard("newer diagnostic", "newer");
    await flushClipboardWrite();

    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledWith("newer");

    resolveFirstWrite();
    await flushClipboardWrite();
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("ignores a pending clipboard completion after unmount", async () => {
    vi.useFakeTimers();
    let resolveWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writeText = vi.fn().mockReturnValue(pendingWrite);
    const onCopy = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    hooks.beginRender();
    const current = useCopyToClipboard<void>({ onCopy });
    current.copyToClipboard("diagnostic");
    hooks.unmount();
    resolveWrite();
    await flushClipboardWrite();

    expect(onCopy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
