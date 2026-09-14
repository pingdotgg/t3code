import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { LiveVoiceTransportCallbacks } from "@t3tools/client-runtime/live-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), createTransport: vi.fn() }));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "voice.start" ? mocks.start : mocks.stop),
}));
vi.mock("./browserVoiceTransport", () => ({ createBrowserVoiceTransport: mocks.createTransport }));

import { useVoiceChat } from "./useVoiceChat";

let root: Root;
let voice: ReturnType<typeof useVoiceChat>;
let testDocument: EventTarget & { nodeType: number; visibilityState: string };
let transports: Array<{ close: ReturnType<typeof vi.fn>; setMuted: ReturnType<typeof vi.fn> }>;
const environmentId = EnvironmentId.make("voice-environment");
const firstThread = ThreadId.make("first-thread");
const secondThread = ThreadId.make("second-thread");

function Probe({
  threadId = firstThread,
  unavailable = false,
}: {
  threadId?: ThreadId;
  unavailable?: boolean;
}) {
  const current = useVoiceChat(environmentId, threadId, unavailable);
  useLayoutEffect(() => {
    voice = current;
  });
  return null;
}

beforeEach(async () => {
  transports = [];
  mocks.start
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { sessionId: "session", sdp: "answer" } });
  mocks.stop.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.createTransport.mockReset().mockImplementation((callbacks: LiveVoiceTransportCallbacks) => {
    const transport = {
      createOffer: async () => "offer",
      acceptAnswer: async () => {
        callbacks.onConnectionState("connected");
        callbacks.onEvent({ type: "session.started" });
      },
      close: vi.fn(),
      setMuted: vi.fn(),
    };
    transports.push(transport);
    return transport;
  });
  testDocument = Object.assign(new EventTarget(), { nodeType: 9, visibilityState: "visible" });
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: testDocument,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", testDocument);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { document: testDocument, HTMLIFrameElement: EventTarget }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
  await act(() =>
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("voice chat ownership", () => {
  it("can start and mute a call after StrictMode effect cleanup and setup", async () => {
    await act(async () => {
      voice.start();
    });
    expect(voice.state.status).toBe("connected");
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: firstThread, sdp: "offer" },
    });
    await act(() => voice.setMuted(true));
    expect(transports[0]!.setMuted).toHaveBeenLastCalledWith(true);
    expect(voice.state.muted).toBe(true);
    await act(() => voice.close());
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(voice.open).toBe(false);
  });

  it("ends the old thread's call before accepting a call for another thread", async () => {
    await act(async () => {
      voice.start();
    });
    await act(() =>
      root.render(
        <StrictMode>
          <Probe threadId={secondThread} />
        </StrictMode>,
      ),
    );
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { sessionId: "session" },
    });
    expect(voice.state.status).toBe("idle");
    expect(voice.open).toBe(false);
    await act(async () => {
      voice.start();
    });
    expect(mocks.start).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId: secondThread, sdp: "offer" },
    });
    expect(voice.state.status).toBe("connected");
  });

  it("releases the microphone when the page goes into the background", async () => {
    await act(async () => {
      voice.start();
    });
    await act(() => {
      testDocument.visibilityState = "hidden";
      testDocument.dispatchEvent(new Event("visibilitychange"));
    });
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(voice.state.status).toBe("idle");
  });

  it("waits for a pending microphone request from the previous thread to settle", async () => {
    let releaseCapture!: (transport: {
      createOffer: () => Promise<string>;
      acceptAnswer: () => Promise<void>;
      close: ReturnType<typeof vi.fn>;
      setMuted: ReturnType<typeof vi.fn>;
    }) => void;
    const pendingCapture = new Promise<Parameters<typeof releaseCapture>[0]>((resolve) => {
      releaseCapture = resolve;
    });
    mocks.createTransport.mockImplementationOnce(() => pendingCapture);
    await act(async () => {
      voice.start();
    });
    await act(() =>
      root.render(
        <StrictMode>
          <Probe threadId={secondThread} />
        </StrictMode>,
      ),
    );
    await act(async () => {
      voice.start();
    });
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    const lateTransport = {
      createOffer: vi.fn(async () => "old-offer"),
      acceptAnswer: async () => undefined,
      close: vi.fn(),
      setMuted: vi.fn(),
    };
    await act(async () => {
      releaseCapture(lateTransport);
    });
    expect(lateTransport.close).toHaveBeenCalledOnce();
    expect(lateTransport.createOffer).not.toHaveBeenCalled();
    expect(mocks.createTransport).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: secondThread, sdp: "offer" },
    });
  });

  it("ends a call when its environment disconnects", async () => {
    await act(async () => {
      voice.start();
    });
    await act(() =>
      root.render(
        <StrictMode>
          <Probe unavailable />
        </StrictMode>,
      ),
    );
    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(voice.state.status).toBe("idle");
    await act(async () => {
      voice.start();
    });
    expect(mocks.createTransport).toHaveBeenCalledOnce();
  });
});
