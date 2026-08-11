import { create } from "zustand";

import {
  initialVoiceSupervisorData,
  reduceVoiceSupervisorState,
  type VoiceSupervisorData,
} from "@t3tools/client-runtime/voice/voice-supervisor-state";
import type { RealtimeServerEvent } from "@t3tools/client-runtime/voice/realtime-events";

export * from "@t3tools/client-runtime/voice/voice-supervisor-state";

export interface VoiceSupervisorStoreState extends VoiceSupervisorData {
  readonly beginSession: (generation: number, at?: number) => void;
  readonly markConnected: (generation: number, at?: number) => void;
  readonly setMuted: (generation: number, muted: boolean) => void;
  readonly ingestEvent: (generation: number, event: RealtimeServerEvent, at?: number) => void;
  readonly failSession: (generation: number, message: string, at?: number) => void;
  readonly endSession: (generation: number, at?: number) => void;
  readonly reset: () => void;
}

const eventTime = (at: number | undefined) => at ?? Date.now();

export const useVoiceSupervisorStore = create<VoiceSupervisorStoreState>()((set) => ({
  ...initialVoiceSupervisorData,
  beginSession: (generation, at) =>
    set((state) =>
      reduceVoiceSupervisorState(state, {
        type: "begin-session",
        generation,
        at: eventTime(at),
      }),
    ),
  markConnected: (generation, at) =>
    set((state) => {
      if (state.generation !== generation) return state;
      if (state.phase === "connected" && state.errorMessage === null) return state;
      return reduceVoiceSupervisorState(state, {
        type: "mark-connected",
        generation,
        at: eventTime(at),
      });
    }),
  setMuted: (generation, muted) =>
    set((state) => reduceVoiceSupervisorState(state, { type: "set-muted", generation, muted })),
  ingestEvent: (generation, event, at) =>
    set((state) => {
      if (
        state.generation !== generation ||
        (state.phase !== "connecting" && state.phase !== "connected")
      ) {
        return state;
      }
      return reduceVoiceSupervisorState(state, {
        type: "ingest-event",
        generation,
        event,
        at: eventTime(at),
      });
    }),
  failSession: (generation, message, at) =>
    set((state) => {
      if (state.generation !== generation) return state;
      return reduceVoiceSupervisorState(state, {
        type: "fail-session",
        generation,
        message,
        at: eventTime(at),
      });
    }),
  endSession: (generation, at) =>
    set((state) => {
      if (state.generation !== generation) return state;
      return reduceVoiceSupervisorState(state, {
        type: "end-session",
        generation,
        at: eventTime(at),
      });
    }),
  reset: () => set((state) => reduceVoiceSupervisorState(state, { type: "reset" })),
}));
