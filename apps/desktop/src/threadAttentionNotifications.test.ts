import { describe, expect, it, vi } from "vitest";
import { EnvironmentId, ThreadId } from "@forma/contracts";

import {
  buildThreadAttentionNotificationCopy,
  showThreadAttentionNotification,
  type ThreadAttentionNotificationFactory,
  type ThreadAttentionNotificationInstance,
  type ThreadAttentionNotificationTarget,
} from "./threadAttentionNotifications.ts";

function makeNotificationFactory(): {
  factory: ThreadAttentionNotificationFactory;
  create: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  triggerClick: () => void;
} {
  let clickListener: (() => void) | null = null;
  const show = vi.fn();
  const create = vi.fn(
    (): ThreadAttentionNotificationInstance => ({
      on: (_event, listener) => {
        clickListener = listener;
      },
      show,
    }),
  );

  return {
    factory: {
      isSupported: () => true,
      create,
    },
    create,
    show,
    triggerClick: () => {
      clickListener?.();
    },
  };
}

function makeTarget(input?: {
  destroyed?: boolean;
  focused?: boolean;
}): ThreadAttentionNotificationTarget {
  return {
    isDestroyed: () => input?.destroyed ?? false,
    isFocused: () => input?.focused ?? false,
  };
}

function makeNotification(input?: { kind?: "approval" | "user-input"; threadTitle?: string }) {
  return {
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make("thread-1"),
    threadTitle: input?.threadTitle ?? "Review config",
    kind: input?.kind ?? ("approval" as const),
  };
}

describe("threadAttentionNotifications", () => {
  it("builds approval notification copy", () => {
    expect(buildThreadAttentionNotificationCopy(makeNotification())).toEqual({
      title: "Approval needed",
      body: 'Thread "Review config" needs approval to continue.',
    });
  });

  it("builds user-input notification copy", () => {
    expect(buildThreadAttentionNotificationCopy(makeNotification({ kind: "user-input" }))).toEqual({
      title: "Input needed",
      body: 'Thread "Review config" is waiting for your input.',
    });
  });

  it("returns false when native notifications are unsupported", () => {
    const create = vi.fn();

    const shown = showThreadAttentionNotification({
      notificationFactory: {
        isSupported: () => false,
        create,
      },
      targetWindow: makeTarget(),
      input: makeNotification(),
      revealWindow: vi.fn(),
      onActivated: vi.fn(),
    });

    expect(shown).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns false when the target window is focused", () => {
    const { factory, create } = makeNotificationFactory();

    const shown = showThreadAttentionNotification({
      notificationFactory: factory,
      targetWindow: makeTarget({ focused: true }),
      input: makeNotification(),
      revealWindow: vi.fn(),
      onActivated: vi.fn(),
    });

    expect(shown).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("reveals the window and emits an activation payload when clicked", () => {
    const { factory, create, show, triggerClick } = makeNotificationFactory();
    const revealWindow = vi.fn();
    const onActivated = vi.fn();
    const input = makeNotification({ kind: "user-input" });

    const shown = showThreadAttentionNotification({
      notificationFactory: factory,
      targetWindow: makeTarget(),
      input,
      revealWindow,
      onActivated,
    });

    expect(shown).toBe(true);
    expect(create).toHaveBeenCalledWith({
      title: "Input needed",
      body: 'Thread "Review config" is waiting for your input.',
    });
    expect(show).toHaveBeenCalledTimes(1);

    triggerClick();

    expect(revealWindow).toHaveBeenCalledTimes(1);
    expect(onActivated).toHaveBeenCalledWith(input);
  });
});
