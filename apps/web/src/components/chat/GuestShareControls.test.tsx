import { EnvironmentId, GuestShareId, ThreadId, type ThreadGuestShare } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  guestShare: null as ThreadGuestShare | null,
}));

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT:
    () =>
    (text: string, values: Record<string, unknown> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])),
  T: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("~/state/entities", () => ({
  useQuietThreadProjection: () =>
    testState.guestShare === null
      ? null
      : { projection: { thread: { guestShare: testState.guestShare } } },
}));

vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    closeGuestShare: {},
    resolveGuestMessage: {},
  },
}));

vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async () => {},
}));

import { GuestShareIndicator } from "./GuestShareControls";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

function makeShare(overrides: Partial<ThreadGuestShare> = {}): ThreadGuestShare {
  return {
    id: GuestShareId.make("share-1"),
    host: "tunnel.example.com",
    createdAt: "2026-11-19T12:00:30.000Z",
    expiresAt: "2026-11-20T12:00:30.000Z",
    guestName: null,
    messages: [],
    ...overrides,
  };
}

function renderIndicator(share: ThreadGuestShare | null): string {
  testState.guestShare = share;
  return renderToStaticMarkup(<GuestShareIndicator threadRef={threadRef} />);
}

describe("GuestShareIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    testState.guestShare = null;
  });

  it("keeps the guest link active during the expiry minute before the exact expiry timestamp", () => {
    vi.setSystemTime(new Date("2026-11-20T12:00:00.000Z"));
    const html = renderIndicator(makeShare({ expiresAt: "2026-11-20T12:00:30.000Z" }));

    expect(html).toContain("Guest link active");
    expect(html).not.toContain("Guest link expired");
  });

  it("keeps a redeemed guest share active 1 ms before expiry and marks it expired at expiry", () => {
    const share = makeShare({
      expiresAt: "2026-11-20T12:00:30.000Z",
      guestName: "Alice",
    });

    vi.setSystemTime(new Date("2026-11-20T12:00:29.999Z"));
    expect(renderIndicator(share)).toContain("Alice is a guest");

    vi.setSystemTime(new Date("2026-11-20T12:00:30.000Z"));
    expect(renderIndicator(share)).toContain("Guest link expired");
  });

  it("compares non-Z ISO timestamps by epoch time rather than lexical prefix", () => {
    // 14:00:30+02:00 === 12:00:30Z
    const plusOffsetShare = makeShare({ expiresAt: "2026-11-20T14:00:30.000+02:00" });
    // 10:00:30-02:00 === 12:00:30Z
    const minusOffsetShare = makeShare({ expiresAt: "2026-11-20T10:00:30.000-02:00" });

    vi.setSystemTime(new Date("2026-11-20T12:00:29.999Z"));
    expect(renderIndicator(plusOffsetShare)).toContain("Guest link active");
    expect(renderIndicator(minusOffsetShare)).toContain("Guest link active");

    vi.setSystemTime(new Date("2026-11-20T12:00:30.000Z"));
    expect(renderIndicator(plusOffsetShare)).toContain("Guest link expired");
    expect(renderIndicator(minusOffsetShare)).toContain("Guest link expired");
  });

  it("does not mark an unparseable expiresAt as expired", () => {
    vi.setSystemTime(new Date("2026-11-20T12:00:30.000Z"));
    for (const invalidExpiresAt of ["", "not-a-timestamp"]) {
      const html = renderIndicator(makeShare({ expiresAt: invalidExpiresAt }));
      expect(html).toContain("Guest link active");
      expect(html).not.toContain("Guest link expired");
    }
  });
});
