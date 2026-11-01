import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createThreadEndRepin, type ThreadEndRepinDeps } from "./thread-end-repin";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<ThreadEndRepinDeps> = {}) {
  const log: string[] = [];
  const deps: ThreadEndRepinDeps = {
    canFollowEnd: () => true,
    scrollToEnd: async (animated) => {
      log.push(`pin:${animated ? "animated" : "instant"}`);
    },
    onScrollFailed: () => log.push("scroll-failed"),
    isKeyboardOpen: () => true,
    blurComposer: () => log.push("blur"),
    dismissKeyboard: async () => {
      log.push("dismiss");
    },
    nextFrame: async () => undefined,
    onKeyboardClosingChange: (closing) => log.push(closing ? "closing" : "closed"),
    ...overrides,
  };
  const endRepin = createThreadEndRepin();
  return {
    log,
    endRepin: {
      repin: () => endRepin.repin(deps),
      closeKeyboard: (animated: boolean) => endRepin.closeKeyboard(deps, animated),
    },
  };
}

describe("createThreadEndRepin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the keyboard, then pins once", async () => {
    const { log, endRepin } = setup();

    await expect(endRepin.closeKeyboard(true)).resolves.toBe(true);

    expect(log).toEqual(["closing", "blur", "dismiss", "closed", "pin:animated"]);
  });

  it("does not pause or pin when no keyboard is open", async () => {
    const { log, endRepin } = setup({ isKeyboardOpen: () => false });

    await expect(endRepin.closeKeyboard(true)).resolves.toBe(false);

    expect(log).toEqual(["blur"]);
  });

  it("starts the close only after a running pin has finished", async () => {
    const pin = deferred();
    const { log, endRepin } = setup({ scrollToEnd: () => pin.promise });
    endRepin.repin();

    const closing = endRepin.closeKeyboard(false);
    await Promise.resolve();
    expect(log).toEqual(["closing"]);

    pin.resolve();
    await closing;
    expect(log).toEqual(["closing", "blur", "dismiss", "closed"]);
  });

  it("still closes the keyboard when the running pin fails", async () => {
    const pin = deferred();
    const scrollToEnd = vi
      .fn(async (): Promise<void> => undefined)
      .mockReturnValueOnce(pin.promise);
    const { log, endRepin } = setup({ scrollToEnd });
    endRepin.repin();

    const closing = endRepin.closeKeyboard(false);
    pin.reject(new Error("no list"));
    await closing;

    expect(log).toEqual(["closing", "scroll-failed", "blur", "dismiss", "closed"]);
  });

  it("drops pins that come due during the close", async () => {
    const dismiss = deferred();
    const pins: boolean[] = [];
    const { endRepin } = setup({
      dismissKeyboard: () => dismiss.promise,
      scrollToEnd: async (animated) => {
        pins.push(animated);
      },
    });

    const closing = endRepin.closeKeyboard(true);
    endRepin.repin();
    expect(pins).toEqual([]);

    dismiss.resolve();
    await closing;
    expect(pins).toEqual([true]);
  });

  it("shares one close between overlapping sends", async () => {
    const dismiss = deferred();
    const { log, endRepin } = setup({ dismissKeyboard: () => dismiss.promise });

    const first = endRepin.closeKeyboard(true);
    const second = endRepin.closeKeyboard(true);
    dismiss.resolve();
    await Promise.all([first, second]);

    expect(log.filter((entry) => entry === "closing")).toHaveLength(1);
    expect(log.filter((entry) => entry === "pin:animated")).toHaveLength(1);
  });

  it("leaves a reader who scrolled away during the close where they are", async () => {
    const dismiss = deferred();
    let following = true;
    const { log, endRepin } = setup({
      canFollowEnd: () => following,
      dismissKeyboard: () => dismiss.promise,
    });

    const closing = endRepin.closeKeyboard(true);
    following = false;
    dismiss.resolve();
    await closing;

    expect(log).not.toContain("pin:animated");
  });

  it("resumes following when the keyboard never reports closing", async () => {
    vi.useFakeTimers();
    const { log, endRepin } = setup({ dismissKeyboard: () => new Promise(() => undefined) });

    const closing = endRepin.closeKeyboard(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;

    expect(log).toEqual(["closing", "blur", "closed", "pin:instant"]);
  });
});
