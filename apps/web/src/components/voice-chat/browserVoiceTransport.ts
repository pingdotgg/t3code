import type { LiveVoiceTransportCallbacks } from "@t3tools/client-runtime/live-voice";

export async function createBrowserVoiceTransport(options: LiveVoiceTransportCallbacks) {
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
    throw new Error("Voice chat needs microphone access in the desktop app or an HTTPS browser.");
  }

  let microphone: MediaStream;
  try {
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "NotAllowedError") {
      throw new Error(
        "Microphone access was denied. Allow it in your browser or system settings, then try again.",
        { cause: error },
      );
    }
    throw error;
  }

  let peer: RTCPeerConnection;
  try {
    peer = new RTCPeerConnection();
  } catch (error) {
    for (const track of microphone.getTracks()) track.stop();
    throw error;
  }
  let audio: HTMLAudioElement;
  let channel: RTCDataChannel;
  try {
    audio = new Audio();
    audio.autoplay = true;
    channel = peer.createDataChannel("oai-events");
  } catch (error) {
    for (const track of microphone.getTracks()) track.stop();
    peer.close();
    throw error;
  }
  let closed = false;
  const lifetime = new AbortController();

  const close = () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    channel.onmessage = null;
    channel.onclose = null;
    channel.onerror = null;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    for (const track of microphone.getTracks()) {
      track.onended = null;
      track.stop();
    }
    audio.pause();
    audio.srcObject = null;
    channel.close();
    peer.close();
  };

  try {
    for (const track of microphone.getAudioTracks()) {
      peer.addTrack(track, microphone);
      track.onended = () => {
        if (!closed) options.onConnectionState("failed");
      };
    }
    channel.onmessage = (event) => {
      if (closed || typeof event.data !== "string") return;
      try {
        options.onEvent(JSON.parse(event.data));
      } catch {
        // Non-JSON messages do not change call state.
      }
    };
    channel.onclose = () => {
      if (!closed) options.onConnectionState("closed");
    };
    channel.onerror = () => {
      if (!closed) options.onConnectionState("failed");
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (
        !closed &&
        (state === "connected" ||
          state === "disconnected" ||
          state === "failed" ||
          state === "closed")
      ) {
        options.onConnectionState(state);
      }
    };
    peer.ontrack = (event) => {
      if (closed) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => {
        if (closed) return;
        options.onEvent({
          type: "error",
          error: {
            message:
              "Audio playback was blocked. Allow sound for this app, then start voice chat again.",
          },
        });
      });
    };
  } catch (error) {
    close();
    throw error;
  }

  return {
    async createOffer() {
      const offer = await peer.createOffer();
      if (closed) throw new Error("Voice chat was cancelled.");
      await peer.setLocalDescription(offer);
      if (closed) throw new Error("Voice chat was cancelled.");
      // This exchange sends one SDP offer, so include gathered candidates before sending it.
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(timeout);
            peer.removeEventListener("icegatheringstatechange", onGatheringChange);
            lifetime.signal.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve();
          };
          const onGatheringChange = () => {
            if (peer.iceGatheringState === "complete") finish();
          };
          const onAbort = () => finish(new Error("Voice chat was cancelled."));
          const timeout = setTimeout(
            () => finish(new Error("The voice connection could not reach the network. Try again.")),
            10_000,
          );
          peer.addEventListener("icegatheringstatechange", onGatheringChange);
          lifetime.signal.addEventListener("abort", onAbort, { once: true });
          onGatheringChange();
          if (lifetime.signal.aborted) onAbort();
        });
      }
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Could not prepare the voice connection.");
      return sdp;
    },
    async acceptAnswer(sdp: string) {
      if (closed) throw new Error("Voice chat was cancelled.");
      await peer.setRemoteDescription({ type: "answer", sdp });
    },
    setMuted(muted: boolean) {
      for (const track of microphone.getAudioTracks()) track.enabled = !muted;
    },
    close,
  };
}
