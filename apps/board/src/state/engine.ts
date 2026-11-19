import { Atom } from "effect/reactivity";

import { engineBridge } from "../connection/bridge";
import type { EngineState } from "../connection/engineState";
import { type EngineConnection, engineConnectionAtom } from "./projects";

export const engineStateAtom = Atom.make<EngineState>((get) => {
  // Subscribe before the read so a change between the two is not lost.
  get.addFinalizer(engineBridge.onEngineState((state) => get.setSelf(state)));
  void engineBridge.engineState().then((state) => get.setSelf(state));
  return { phase: "connecting" };
}).pipe(Atom.withLabel("engine-state"));

export type EngineStatus =
  | { readonly tone: "ok" | "busy" | "off"; readonly text: string; readonly detail?: string }
  | { readonly tone: "ask" };

/** How the app reached the engine and where the connection to it stands. */
export function deriveEngineStatus(
  engine: EngineState,
  connection: EngineConnection,
): EngineStatus {
  switch (engine.phase) {
    case "starting":
      return { tone: "busy", text: "Starting engine in WSL" };
    case "connecting":
      return { tone: "busy", text: "Connecting" };
    case "install-needed":
      return { tone: "ask" };
    case "offline":
      return { tone: "off", text: "Offline", detail: engine.reason };
    case "ready":
      if (connection.unsupportedReason !== undefined) {
        return { tone: "off", text: "Offline", detail: connection.unsupportedReason };
      }
      if (connection.state.phase === "connected") {
        return {
          tone: "ok",
          text: `Engine connected · ${engine.route === "env" ? "url" : engine.route}`,
        };
      }
      if (connection.state.phase === "blocked") {
        return {
          tone: "off",
          text: "Offline",
          detail: connection.state.lastFailure?.detail ?? "The engine refused the connection",
        };
      }
      return { tone: "busy", text: "Connecting" };
  }
}

export const engineStatusAtom = Atom.make((get) =>
  deriveEngineStatus(get(engineStateAtom), get(engineConnectionAtom)),
).pipe(Atom.withLabel("engine-status"));
