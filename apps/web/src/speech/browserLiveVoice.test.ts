import { expect, it, vi } from "vite-plus/test";
import { BrowserLiveVoice } from "./browserLiveVoice";

it("releases a microphone granted after the user cancels without opening a remote call", async () => {
  let grant!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  const stop = vi.fn();
  const open = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission } });
  vi.stubGlobal("RTCPeerConnection", vi.fn());
  try {
    const voice = new BrowserLiveVoice({
      open,
      poll: vi.fn(),
      stop: vi.fn(),
      onPhase: vi.fn(),
      onTranscript: vi.fn(),
    });
    const starting = voice.start("sol");
    voice.stop();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not request microphone access when cancelled while resolving the preferred device", async () => {
  let choose!: (id: string) => void;
  const preference = new Promise<string>((resolve) => {
    choose = resolve;
  });
  const capture = vi.fn();
  const open = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
  vi.stubGlobal("RTCPeerConnection", vi.fn());
  try {
    const voice = new BrowserLiveVoice({
      open,
      poll: vi.fn(),
      stop: vi.fn(),
      getMicrophoneId: () => preference,
      onPhase: vi.fn(),
      onTranscript: vi.fn(),
    });
    const starting = voice.start("aube");
    voice.stop();
    choose("preferred-device");
    await starting;
    expect(capture).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
