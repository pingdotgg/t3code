import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { threadBoundAnnotationSender, type ThreadAnnotationSender } from "./panelHost";

const THREAD_A = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-a")),
);
const THREAD_B = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-b")),
);
const THREAD_A_ELSEWHERE = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("environment-2"), ThreadId.make("thread-a")),
);

const annotation: PreviewAnnotationPayload = {
  id: "annotation-1",
  pageUrl: "https://example.com/dashboard",
  pageTitle: "Dashboard",
  comment: "Tighten this spacing",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-07-27T00:00:00.000Z",
};

describe("threadBoundAnnotationSender", () => {
  it("drops a pick that settles after the chat view moved to another thread", async () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const senderRef: { current: ThreadAnnotationSender | null } = {
      current: { threadKey: THREAD_A, send: sendA },
    };
    const hostSendForA = threadBoundAnnotationSender(() => senderRef.current, THREAD_A);

    let resolvePick!: (value: PreviewAnnotationPayload) => void;
    const pick = new Promise<PreviewAnnotationPayload>((resolve) => {
      resolvePick = resolve;
    });
    const settled = pick.then((picked) => hostSendForA(picked, null));

    // The shared ChatView renders thread B before A's pick is cancelled.
    senderRef.current = { threadKey: THREAD_B, send: sendB };
    resolvePick(annotation);
    await settled;

    expect(sendB).not.toHaveBeenCalled();
    expect(sendA).not.toHaveBeenCalled();
  });

  it("treats the same thread id in another environment as a different thread", () => {
    const sendElsewhere = vi.fn();
    const senderRef = { current: { threadKey: THREAD_A_ELSEWHERE, send: sendElsewhere } };

    threadBoundAnnotationSender(() => senderRef.current, THREAD_A)(annotation, null);

    expect(sendElsewhere).not.toHaveBeenCalled();
  });

  it("uses the newest sender after a same-thread rerender", () => {
    const firstRender = vi.fn();
    const latestRender = vi.fn();
    const senderRef: { current: ThreadAnnotationSender | null } = {
      current: { threadKey: THREAD_A, send: firstRender },
    };
    const hostSend = threadBoundAnnotationSender(() => senderRef.current, THREAD_A);

    senderRef.current = { threadKey: THREAD_A, send: latestRender };
    hostSend(annotation, null);

    expect(firstRender).not.toHaveBeenCalled();
    expect(latestRender).toHaveBeenCalledWith(annotation, null);
  });
});
