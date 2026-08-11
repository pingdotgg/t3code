import type { RealtimeServerEvent } from "@t3tools/client-runtime/voice/realtime-events";
import type { VoiceSupervisorStateProjector } from "@t3tools/client-runtime/voice/voice-supervisor-host";
import {
  initialVoiceSupervisorData,
  reduceVoiceSupervisorState,
  type VoiceSupervisorAction,
  type VoiceSupervisorData,
} from "@t3tools/client-runtime/voice/voice-supervisor-state";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

export interface MobileVoiceSupervisorStore {
  readonly dataAtom: Atom.Writable<VoiceSupervisorData>;
  readonly projector: VoiceSupervisorStateProjector;
}

const eventTime = (at: number | undefined) => at ?? Date.now();

export function createMobileVoiceSupervisorStore(
  registry: AtomRegistry.AtomRegistry,
): MobileVoiceSupervisorStore {
  const dataAtom = Atom.make<VoiceSupervisorData>(initialVoiceSupervisorData).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:voice-supervisor:data"),
  );

  const dispatch = (action: VoiceSupervisorAction) => {
    const current = registry.get(dataAtom);
    const next = reduceVoiceSupervisorState(current, action);
    if (next !== current) registry.set(dataAtom, next);
  };

  const projector: VoiceSupervisorStateProjector = {
    beginSession: (generation, at) =>
      dispatch({ type: "begin-session", generation, at: eventTime(at) }),
    markConnected: (generation, at) =>
      dispatch({ type: "mark-connected", generation, at: eventTime(at) }),
    setMuted: (generation, muted) => dispatch({ type: "set-muted", generation, muted }),
    ingestEvent: (generation, event: RealtimeServerEvent, at) =>
      dispatch({ type: "ingest-event", generation, event, at: eventTime(at) }),
    failSession: (generation, message, at) =>
      dispatch({ type: "fail-session", generation, message, at: eventTime(at) }),
    endSession: (generation, at) =>
      dispatch({ type: "end-session", generation, at: eventTime(at) }),
    reset: () => dispatch({ type: "reset" }),
  };

  return { dataAtom, projector };
}
