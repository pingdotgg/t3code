/* oxlint-disable unicorn/prefer-add-event-listener -- WebRTC 124.0.8 omits inherited EventTarget declarations; each native object is owned exclusively here. */
import type {
  LiveVoiceTransport,
  LiveVoiceTransportCallbacks,
} from "@t3tools/client-runtime/live-voice";
import type { MediaStream, RTCPeerConnection } from "react-native-webrtc";
import { reserveLiveVoiceMicrophone } from "./microphoneReservation";

export function createNativeLiveVoiceTransport(
  callbacks: LiveVoiceTransportCallbacks,
): LiveVoiceTransport {
  let peer: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let channel: ReturnType<RTCPeerConnection["createDataChannel"]> | null = null;
  let closed = false;
  let muted = false;
  let cancelIce: (() => void) | null = null;
  let preparing = false;
  let releaseReservation: (() => void) | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    cancelIce?.();
    // stop() only disables a React Native WebRTC track. release() frees its
    // native capture resources as well as the stream itself.
    for (const release of [
      () => channel?.close(),
      () => peer?.close(),
      () => stream?.getTracks().forEach((track) => track.stop()),
      () => stream?.release(),
    ]) {
      try {
        release();
      } catch {
        /* Continue releasing the remaining resources. */
      }
    }
    channel = null;
    peer = null;
    stream = null;
    if (!preparing) releaseReservation?.();
  };

  return {
    async createOffer() {
      releaseReservation = reserveLiveVoiceMicrophone();
      preparing = true;
      try {
        // Loading on demand lets an older dev client show a rebuild error without
        // crashing the entire composer when its native module is absent.
        const rtc = await import("react-native-webrtc").catch(() => {
          throw new Error("Voice chat needs an updated app build. Rebuild or update T3 Code.");
        });
        if (closed) throw new Error("Voice chat ended.");
        const captured = await rtc.mediaDevices.getUserMedia({ audio: true, video: false });
        if (closed) {
          captured.getTracks().forEach((track) => track.stop());
          captured.release();
          throw new Error("Voice chat ended.");
        }
        stream = captured;
        captured.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        });
        const connection = new rtc.RTCPeerConnection();
        peer = connection;
        connection.onconnectionstatechange = () => {
          if (closed) return;
          const state = connection.connectionState;
          if (state === "failed" || state === "disconnected" || state === "closed") {
            callbacks.onConnectionState(state);
          }
        };
        captured.getTracks().forEach((track) => {
          track.onended = () => {
            if (!closed) callbacks.onConnectionState("disconnected");
          };
          connection.addTrack(track, captured);
        });
        const events = connection.createDataChannel("oai-events");
        channel = events;
        events.onopen = () => {
          if (!closed) callbacks.onConnectionState("connected");
        };
        events.onclose = () => {
          if (!closed) callbacks.onConnectionState("disconnected");
        };
        events.onerror = () => {
          if (!closed) callbacks.onConnectionState("failed");
        };
        events.onmessage = (event: { data: unknown }) => {
          if (closed || typeof event.data !== "string") return;
          try {
            callbacks.onEvent(JSON.parse(event.data));
          } catch {
            // Unknown or malformed events do not end an otherwise healthy call.
          }
        };
        const offer = await connection.createOffer({});
        if (closed) throw new Error("Voice chat ended.");
        await connection.setLocalDescription(offer);
        if (closed) throw new Error("Voice chat ended.");
        if (connection.iceGatheringState !== "complete") {
          await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
              clearTimeout(timeout);
              connection.onicegatheringstatechange = null;
              cancelIce = null;
              if (error) reject(error);
              else resolve();
            };
            const onGathering = () => {
              if (connection.iceGatheringState === "complete") finish();
            };
            const timeout = setTimeout(
              () => finish(new Error("Voice connection timed out.")),
              10_000,
            );
            cancelIce = () => finish(new Error("Voice chat ended."));
            connection.onicegatheringstatechange = onGathering;
            onGathering();
          });
        }
        if (closed) throw new Error("Voice chat ended.");
        const sdp = connection.localDescription?.sdp;
        if (!sdp) throw new Error("Could not prepare microphone audio.");
        return sdp;
      } catch (error) {
        close();
        throw error;
      } finally {
        preparing = false;
        if (closed) releaseReservation?.();
      }
    },
    async acceptAnswer(sdp) {
      if (closed || !peer) throw new Error("Voice chat ended.");
      await peer.setRemoteDescription({ type: "answer", sdp });
    },
    setMuted(value) {
      muted = value;
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = !value;
      });
    },
    close,
  };
}
